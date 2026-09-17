package monitor

import (
	"log"
	"regexp"
	"time"

	"ops-sentinel/internal/store"
)

// 主机资源采样：每轮抓取拿到的 node_exporter 原始 counter，和上一轮做差分
// 得到 CPU%、磁盘/网络速率，每台约 1 分钟存一行给资源趋势图用。
//
// 放在抓取路径里而不是新开采集器：数据本来就在 families 里，多算一步即可，
// 不用改规则引擎，也不用改 18 台机器上的脚本。

// hostPrev 是上一轮的累计值，只保留做差分需要的几个和。
type hostPrev struct {
	at                           time.Time
	cpuIdle, cpuIowait, cpuTotal float64
	diskRead, diskWrite, diskOps float64
	diskIOTime                   map[string]float64 // 按盘，算"最忙那块盘"的繁忙度
	netRx, netTx                 float64
}

// 整盘设备（不含分区，分区会和整盘重复计数）
var hostDiskRe = regexp.MustCompile(`^(sd[a-z]+|vd[a-z]+|xvd[a-z]+|nvme\d+n\d+|md\d+)$`)

// 虚拟网卡：容器/网桥/隧道，只看物理口
var hostNetSkipRe = regexp.MustCompile(`^(lo|veth.*|docker.*|br-.*|virbr.*|tap.*|incusbr.*|lxdbr.*|cali.*|flannel.*|cni.*|kube.*|vxlan.*|tunl.*|dummy.*|wg.*)$`)

const hostSampleEvery = 55 * time.Second

func (m *PromManager) sampleHostResources(target *store.PromTarget, families map[string][]promSample) {
	if target.Kind != "node" {
		return
	}
	now := time.Now()
	cur := hostPrev{at: now, diskIOTime: map[string]float64{}}
	for _, s := range families["node_cpu_seconds_total"] {
		cur.cpuTotal += s.Value
		switch s.Labels["mode"] {
		case "idle":
			cur.cpuIdle += s.Value
		case "iowait":
			cur.cpuIowait += s.Value
		}
	}
	if cur.cpuTotal == 0 {
		return // 不是 node_exporter 端点
	}
	sumDisk := func(name string) float64 {
		t := 0.0
		for _, s := range families[name] {
			if hostDiskRe.MatchString(s.Labels["device"]) {
				t += s.Value
			}
		}
		return t
	}
	cur.diskRead = sumDisk("node_disk_read_bytes_total")
	cur.diskWrite = sumDisk("node_disk_written_bytes_total")
	cur.diskOps = sumDisk("node_disk_reads_completed_total") + sumDisk("node_disk_writes_completed_total")
	for _, s := range families["node_disk_io_time_seconds_total"] {
		if hostDiskRe.MatchString(s.Labels["device"]) {
			cur.diskIOTime[s.Labels["device"]] = s.Value
		}
	}
	sumNet := func(name string) float64 {
		t := 0.0
		for _, s := range families[name] {
			if !hostNetSkipRe.MatchString(s.Labels["device"]) {
				t += s.Value
			}
		}
		return t
	}
	cur.netRx = sumNet("node_network_receive_bytes_total")
	cur.netTx = sumNet("node_network_transmit_bytes_total")

	m.hrMu.Lock()
	prev := m.hostPrev[target.ID]
	if prev == nil {
		m.hostPrev[target.ID] = &cur
		m.hrMu.Unlock()
		return
	}
	dt := now.Sub(prev.at).Seconds()
	if dt < hostSampleEvery.Seconds() {
		m.hrMu.Unlock()
		return // 差分窗口约 1 分钟，中间的抓取轮次跳过
	}
	m.hostPrev[target.ID] = &cur
	m.hrMu.Unlock()

	rate := func(a, b float64) float64 { // counter 重置（重启）时按 0 处理
		if b < a || dt <= 0 {
			return 0
		}
		return (b - a) / dt
	}
	h := store.HostSample{Ts: now.Unix()}
	if dTotal := cur.cpuTotal - prev.cpuTotal; dTotal > 0 {
		h.CPUPct = clampPct(100 * (1 - (cur.cpuIdle-prev.cpuIdle)/dTotal))
		h.IowaitPct = clampPct(100 * (cur.cpuIowait - prev.cpuIowait) / dTotal)
	}
	if avail, total := firstValue(families["node_memory_MemAvailable_bytes"]), firstValue(families["node_memory_MemTotal_bytes"]); total > 0 {
		h.MemPct = clampPct(100 * (1 - avail/total))
		h.MemTotal = total
	}
	// 根分区容量：只取 mountpoint="/" 那一行，卡片据此显示 已用/可用/共，而不只有百分比
	if total := rootFSValue(families["node_filesystem_size_bytes"]); total > 0 {
		h.FSTotal = total
		h.FSAvail = rootFSValue(families["node_filesystem_avail_bytes"])
	}
	// 容器内存最高的那个容器的上限：卡片只显示百分比时看不出还剩多少，
	// 有了上限就能按 百分比 × 上限 反推已用与可用。两种口径各存一份，
	// 因为数据库节点的规则盯 anon、其余盯 working_set，最高的容器可能不是同一个。
	h.CtrWsLimit = topContainerLimit(families, "ttpos_container_memory_usage_ratio")
	h.CtrAnonLimit = topContainerLimit(families, "ttpos_container_memory_anon_ratio")
	h.DiskReadBps = rate(prev.diskRead, cur.diskRead)
	h.DiskWriteBps = rate(prev.diskWrite, cur.diskWrite)
	h.DiskIOPS = rate(prev.diskOps, cur.diskOps)
	for dev, v := range cur.diskIOTime {
		if u := clampPct(100 * rate(prev.diskIOTime[dev], v)); u > h.DiskUtilPct {
			h.DiskUtilPct = u
		}
	}
	h.NetRxBps = rate(prev.netRx, cur.netRx)
	h.NetTxBps = rate(prev.netTx, cur.netTx)

	if err := m.store.InsertHostSample(target.ID, &h); err != nil {
		log.Printf("[prom] host sample %s: %v", target.Name, err)
	}
}

// topContainerLimit 找出 ratioMetric 最高的那个容器，返回它的内存上限字节；
// 没有样本或该容器没设上限时返回 0，前端据此退回只显示百分比。
func topContainerLimit(families map[string][]promSample, ratioMetric string) float64 {
	best, name := -1.0, ""
	for _, s := range families[ratioMetric] {
		if s.Value > best {
			best, name = s.Value, s.Labels["container"]
		}
	}
	if name == "" {
		return 0
	}
	for _, s := range families["ttpos_container_memory_limit_bytes"] {
		if s.Labels["container"] == name {
			return s.Value
		}
	}
	return 0
}

// rootFSValue 取 mountpoint="/" 的样本值；没有就返回 0（比如容器化的 node_exporter 没挂根分区）。
func rootFSValue(ss []promSample) float64 {
	for _, s := range ss {
		if s.Labels["mountpoint"] == "/" {
			return s.Value
		}
	}
	return 0
}

func firstValue(ss []promSample) float64 {
	if len(ss) == 0 {
		return 0
	}
	return ss[0].Value
}

func clampPct(v float64) float64 {
	if v < 0 {
		return 0
	}
	if v > 100 {
		return 100
	}
	return v
}
