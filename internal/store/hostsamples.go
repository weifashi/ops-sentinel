package store

import (
	"fmt"
	"time"
)

// 主机资源时序：CPU / 内存 / 磁盘 IO / 网络 IO，每台 node 目标每分钟一行。
//
// 数据来自 PromManager 每轮抓到的 node_exporter 原始 counter，在内存里与
// 上一轮做差分得到速率，这里只存算好的结果。规模账：21 台 × 1440 行/天 ×
// 7 天 ≈ 21 万行，远小于 metric_samples。查询按范围长度分桶取均值。
type HostSample struct {
	Ts           int64   `json:"t"`         // unix 秒（分桶后为桶起点）
	CPUPct       float64 `json:"cpu"`       // CPU 使用率 %（1 - idle）
	IowaitPct    float64 `json:"iowait"`    // CPU 等 IO 的比例 %
	MemPct       float64 `json:"mem"`       // 内存使用率 %（1 - MemAvailable/MemTotal）
	MemTotal     float64 `json:"mem_total"` // 总内存字节，前端据此换算已用/可用 GB
	FSTotal      float64 `json:"fs_total"`  // 根分区总字节（mountpoint=/），前端换算已用/可用
	FSAvail      float64 `json:"fs_avail"`  // 根分区可用字节
	DiskReadBps  float64 `json:"disk_r"`    // 磁盘读 B/s（整盘，不含分区重复计数）
	DiskWriteBps float64 `json:"disk_w"`    // 磁盘写 B/s
	DiskIOPS     float64 `json:"disk_iops"` // 读+写 完成次数 /s
	DiskUtilPct  float64 `json:"disk_util"` // 最忙那块盘的繁忙度 %
	NetRxBps     float64 `json:"net_rx"`    // 物理网卡下行 B/s
	NetTxBps     float64 `json:"net_tx"`    // 物理网卡上行 B/s
}

func (s *Store) InsertHostSample(targetID int64, h *HostSample) error {
	_, err := s.db.Exec(`INSERT INTO host_samples
		(target_id, ts, cpu_pct, iowait_pct, mem_pct, mem_total_bytes, fs_total_bytes, fs_avail_bytes, disk_read_bps, disk_write_bps, disk_iops, disk_util_pct, net_rx_bps, net_tx_bps)
		VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		targetID, h.Ts, h.CPUPct, h.IowaitPct, h.MemPct, h.MemTotal, h.FSTotal, h.FSAvail, h.DiskReadBps, h.DiskWriteBps, h.DiskIOPS, h.DiskUtilPct, h.NetRxBps, h.NetTxBps)
	return err
}

// ListHostSamples 返回 [from, to] 内的时序，按 bucketSec 分桶取均值。
func (s *Store) ListHostSamples(targetID int64, from, to time.Time, bucketSec int) ([]HostSample, error) {
	if bucketSec <= 0 {
		bucketSec = 60
	}
	rows, err := s.db.Query(fmt.Sprintf(`SELECT (ts/%d)*%d AS bucket,
			AVG(cpu_pct), AVG(iowait_pct), AVG(mem_pct), MAX(mem_total_bytes), MAX(fs_total_bytes), AVG(fs_avail_bytes),
			AVG(disk_read_bps), AVG(disk_write_bps), AVG(disk_iops), MAX(disk_util_pct),
			AVG(net_rx_bps), AVG(net_tx_bps)
		FROM host_samples WHERE target_id = ? AND ts >= ? AND ts <= ?
		GROUP BY bucket ORDER BY bucket`, bucketSec, bucketSec),
		targetID, from.Unix(), to.Unix())
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := []HostSample{}
	for rows.Next() {
		var h HostSample
		if rows.Scan(&h.Ts, &h.CPUPct, &h.IowaitPct, &h.MemPct, &h.MemTotal, &h.FSTotal, &h.FSAvail,
			&h.DiskReadBps, &h.DiskWriteBps, &h.DiskIOPS, &h.DiskUtilPct,
			&h.NetRxBps, &h.NetTxBps) == nil {
			out = append(out, h)
		}
	}
	return out, rows.Err()
}

// PurgeOldHostSamples 只保留最近 7 天。
func (s *Store) PurgeOldHostSamples() (int64, error) {
	res, err := s.db.Exec(`DELETE FROM host_samples WHERE ts < ?`,
		time.Now().Add(-7*24*time.Hour).Unix())
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// LatestHostSamples 每个目标最新一行（对象列表悬停换算已用/可用 GB 用）。
func (s *Store) LatestHostSamples() (map[int64]HostSample, error) {
	rows, err := s.db.Query(`SELECT h.target_id, h.ts, h.cpu_pct, h.iowait_pct, h.mem_pct, h.mem_total_bytes, h.fs_total_bytes, h.fs_avail_bytes,
			h.disk_read_bps, h.disk_write_bps, h.disk_iops, h.disk_util_pct, h.net_rx_bps, h.net_tx_bps
		FROM host_samples h
		JOIN (SELECT target_id, MAX(ts) AS ts FROM host_samples GROUP BY target_id) m
		  ON m.target_id = h.target_id AND m.ts = h.ts`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	out := map[int64]HostSample{}
	for rows.Next() {
		var id int64
		var h HostSample
		if rows.Scan(&id, &h.Ts, &h.CPUPct, &h.IowaitPct, &h.MemPct, &h.MemTotal, &h.FSTotal, &h.FSAvail,
			&h.DiskReadBps, &h.DiskWriteBps, &h.DiskIOPS, &h.DiskUtilPct,
			&h.NetRxBps, &h.NetTxBps) == nil {
			out[id] = h
		}
	}
	return out, rows.Err()
}
