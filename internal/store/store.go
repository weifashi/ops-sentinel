package store

import (
	"context"
	"database/sql"
	_ "embed"
	"encoding/json"
	"fmt"
	"log"
	"strings"
	"time"

	"ops-sentinel/internal/auth"

	_ "modernc.org/sqlite"
)

//go:embed schema.sql
var schemaSQL string

type Database struct {
	ID           int64     `json:"id"`
	Name         string    `json:"name"`
	Host         string    `json:"host"`
	Port         int       `json:"port"`
	User         string    `json:"user"`
	Password     string    `json:"password"`
	IntervalSec  int       `json:"interval_sec"`
	ThresholdSec int       `json:"threshold_sec"`
	Enabled      bool      `json:"enabled"`
	CreatedAt    time.Time `json:"created_at"`
	UpdatedAt    time.Time `json:"updated_at"`
}

func (d *Database) DSN() string {
	return fmt.Sprintf("%s:%s@tcp(%s:%d)/performance_schema", d.User, d.Password, d.Host, d.Port)
}

type NotificationConfig struct {
	ID         int64           `json:"id"`
	DatabaseID *int64          `json:"database_id"`
	ScopeType  string          `json:"scope_type"`
	Type       string          `json:"type"`
	ConfigJSON json.RawMessage `json:"config_json"`
	Enabled    bool            `json:"enabled"`
	CreatedAt  time.Time       `json:"created_at"`
	UpdatedAt  time.Time       `json:"updated_at"`
}

type DingTalkConfig struct {
	Webhook string `json:"webhook"`
	Secret  string `json:"secret"`
}

type FeishuConfig struct {
	Webhook string `json:"webhook"`
	Secret  string `json:"secret"`
}

type EmailConfig struct {
	SMTPHost string `json:"smtp_host"`
	SMTPPort int    `json:"smtp_port"`
	Username string `json:"username"`
	Password string `json:"password"`
	From     string `json:"from"`
	To       string `json:"to"`
}

type DooTaskConfig struct {
	BaseURL  string `json:"base_url"`
	Token    string `json:"token"`
	DialogID string `json:"dialog_id"`
}

type User struct {
	ID          int64     `json:"id"`
	Username    string    `json:"username"`
	GitHubID    int64     `json:"github_id,omitempty"`
	GitHubLogin string    `json:"github_login,omitempty"`
	AvatarURL   string    `json:"avatar_url,omitempty"`
	Role        string    `json:"role"`
	CreatedAt   time.Time `json:"created_at"`
}

type SlowQueryLog struct {
	ID           int64     `json:"id"`
	DatabaseID   int64     `json:"database_id"`
	DatabaseName string    `json:"database_name"`
	ThreadID     uint64    `json:"thread_id"`
	ProcessID    uint64    `json:"process_id"`
	User         string    `json:"user"`
	Host         string    `json:"host"`
	DBName       string    `json:"db_name"`
	SQLText      string    `json:"sql_text"`
	ExecSec      float64   `json:"exec_sec"`
	LockSec      float64   `json:"lock_sec"`
	RowsExamined uint64    `json:"rows_examined"`
	RowsSent     uint64    `json:"rows_sent"`
	State        string    `json:"state"`
	DetectedAt   time.Time `json:"detected_at"`
}

type Store struct {
	db *sql.DB
}

func New(dataDir string) (*Store, error) {
	dsn := fmt.Sprintf("file:%s/monitor.db", dataDir)
	db, err := sql.Open("sqlite", dsn)
	if err != nil {
		return nil, fmt.Errorf("open sqlite: %w", err)
	}
	db.SetMaxOpenConns(1)
	db.SetMaxIdleConns(1)
	db.SetConnMaxLifetime(0)
	if err := db.Ping(); err != nil {
		db.Close()
		return nil, fmt.Errorf("ping sqlite: %w", err)
	}
	if err := configureSQLite(db); err != nil {
		db.Close()
		return nil, err
	}
	if _, err := db.Exec(schemaSQL); err != nil {
		db.Close()
		return nil, fmt.Errorf("init schema: %w", err)
	}
	// Auto-migrate: add missing columns
	migrations := []string{
		"ALTER TABLE alert_events ADD COLUMN detail TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE prom_checks ADD COLUMN diag_url TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE prom_checks ADD COLUMN absent_as_zero INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE prom_checks ADD COLUMN observe_only INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE custom_sql_checks ADD COLUMN diag_sql TEXT NOT NULL DEFAULT ''",
		`CREATE TABLE IF NOT EXISTS metric_samples (
			check_id INTEGER NOT NULL,
			ts       INTEGER NOT NULL,
			value    REAL    NOT NULL
		)`,
		"CREATE INDEX IF NOT EXISTS idx_metric_samples_check_ts ON metric_samples (check_id, ts)",
		`CREATE TABLE IF NOT EXISTS host_samples (
			target_id      INTEGER NOT NULL,
			ts             INTEGER NOT NULL,
			cpu_pct        REAL NOT NULL DEFAULT 0,
			iowait_pct     REAL NOT NULL DEFAULT 0,
			mem_pct        REAL NOT NULL DEFAULT 0,
			disk_read_bps  REAL NOT NULL DEFAULT 0,
			disk_write_bps REAL NOT NULL DEFAULT 0,
			disk_iops      REAL NOT NULL DEFAULT 0,
			disk_util_pct  REAL NOT NULL DEFAULT 0,
			net_rx_bps     REAL NOT NULL DEFAULT 0,
			net_tx_bps     REAL NOT NULL DEFAULT 0
		)`,
		"CREATE INDEX IF NOT EXISTS idx_host_samples_target_ts ON host_samples (target_id, ts)",
		"ALTER TABLE host_samples ADD COLUMN mem_total_bytes REAL NOT NULL DEFAULT 0",
		"ALTER TABLE host_samples ADD COLUMN fs_total_bytes REAL NOT NULL DEFAULT 0",
		"ALTER TABLE host_samples ADD COLUMN fs_avail_bytes REAL NOT NULL DEFAULT 0",
		"ALTER TABLE grafana_configs ADD COLUMN webhook_secret TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE rocketmq_configs ADD COLUMN notify_new_msg INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE rocketmq_alert_logs ADD COLUMN message_body TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE notification_configs ADD COLUMN scope_type TEXT NOT NULL DEFAULT 'all'",
		"ALTER TABLE notified_pids ADD COLUMN sql_fingerprint TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE health_checks ADD COLUMN alert_field TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE health_checks ADD COLUMN alert_strategy TEXT NOT NULL DEFAULT 'threshold'",
		"ALTER TABLE health_checks ADD COLUMN alert_condition TEXT NOT NULL DEFAULT 'gt'",
		"ALTER TABLE health_checks ADD COLUMN alert_value TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE health_checks ADD COLUMN alert_delta_value TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE health_checks ADD COLUMN alert_delta_percent TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE health_checks ADD COLUMN alert_consecutive INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE health_checks ADD COLUMN alert_rules TEXT NOT NULL DEFAULT '[]'",
		"ALTER TABLE health_checks ADD COLUMN trigger_actions TEXT NOT NULL DEFAULT '[]'",
		"ALTER TABLE health_check_logs ADD COLUMN diagnostic_output TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE custom_sql_checks ADD COLUMN result_field TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE custom_sql_checks ADD COLUMN alert_strategy TEXT NOT NULL DEFAULT 'threshold'",
		"ALTER TABLE custom_sql_checks ADD COLUMN alert_delta_value TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE custom_sql_checks ADD COLUMN alert_delta_percent TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE custom_sql_checks ADD COLUMN alert_consecutive INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE custom_sql_checks ADD COLUMN alert_rules TEXT NOT NULL DEFAULT '[]'",
		"ALTER TABLE custom_sql_checks ADD COLUMN trigger_actions TEXT NOT NULL DEFAULT '[]'",
		"ALTER TABLE cloud_logging_configs ADD COLUMN resource_names TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE cloud_logging_configs ADD COLUMN credentials_file TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE cloud_logging_configs ADD COLUMN default_filter TEXT NOT NULL DEFAULT ''",
		"ALTER TABLE cloud_logging_configs ADD COLUMN interval_sec INTEGER NOT NULL DEFAULT 60",
		"ALTER TABLE cloud_logging_configs ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE cloud_logging_checks ADD COLUMN metric_type TEXT NOT NULL DEFAULT 'count'",
		"ALTER TABLE cloud_logging_checks ADD COLUMN lookback_minutes INTEGER NOT NULL DEFAULT 5",
		"ALTER TABLE cloud_logging_checks ADD COLUMN threshold_count INTEGER NOT NULL DEFAULT 0",
		"ALTER TABLE cloud_logging_checks ADD COLUMN interval_sec INTEGER NOT NULL DEFAULT 60",
		"ALTER TABLE cloud_logging_checks ADD COLUMN notify_enabled INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE cloud_logging_checks ADD COLUMN recovery_notify INTEGER NOT NULL DEFAULT 1",
		"ALTER TABLE cloud_logging_checks ADD COLUMN enabled INTEGER NOT NULL DEFAULT 1",
	}
	// Migrate existing data: database_id not null → scope_type='mysql'
	db.Exec(`UPDATE notification_configs SET scope_type='mysql' WHERE database_id IS NOT NULL AND scope_type='all'`)
	for _, m := range migrations {
		db.Exec(m) // ignore errors (column may already exist)
	}

	// Recreate notification_configs without CHECK constraint to support new types (dootask etc.)
	var hasCheck int
	db.QueryRow(`SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='notification_configs' AND sql LIKE '%CHECK%'`).Scan(&hasCheck)
	if hasCheck > 0 {
		if tx, txErr := db.Begin(); txErr == nil {
			if _, err := tx.Exec(`CREATE TABLE IF NOT EXISTS notification_configs_new (
				id INTEGER PRIMARY KEY AUTOINCREMENT, database_id INTEGER, scope_type TEXT NOT NULL DEFAULT 'all',
				type TEXT NOT NULL, config_json TEXT NOT NULL DEFAULT '{}', enabled INTEGER NOT NULL DEFAULT 1,
				created_at DATETIME NOT NULL DEFAULT (datetime('now')), updated_at DATETIME NOT NULL DEFAULT (datetime('now')))`); err == nil {
				if _, err = tx.Exec(`INSERT INTO notification_configs_new SELECT id, database_id, scope_type, type, config_json, enabled, created_at, updated_at FROM notification_configs`); err == nil {
					if _, err = tx.Exec(`DROP TABLE notification_configs`); err == nil {
						tx.Exec(`ALTER TABLE notification_configs_new RENAME TO notification_configs`)
					}
				}
			}
			tx.Commit()
		}
	}

	return &Store{db: db}, nil
}

func configureSQLite(db *sql.DB) error {
	pragmas := []string{
		// Docker Desktop bind mounts on macOS are less reliable with WAL sidecar
		// files when the host also inspects the database. Rollback journal keeps
		// all writes in one file path and avoids recurring settings/log index
		// corruption seen with monitor.db-wal/monitor.db-shm.
		"PRAGMA journal_mode=DELETE",
		"PRAGMA synchronous=FULL",
		"PRAGMA busy_timeout=5000",
		"PRAGMA foreign_keys=ON",
	}
	for _, stmt := range pragmas {
		if _, err := db.Exec(stmt); err != nil {
			return fmt.Errorf("configure sqlite %q: %w", stmt, err)
		}
	}
	return nil
}

func (s *Store) Close() error {
	return s.db.Close()
}

// --- Database CRUD ---

func (s *Store) ListDatabases() ([]Database, error) {
	rows, err := s.db.Query(`SELECT id, name, host, port, user, password, interval_sec, threshold_sec, enabled, created_at, updated_at FROM databases ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []Database
	for rows.Next() {
		var d Database
		var enabled int
		var encPwd string
		if err := rows.Scan(&d.ID, &d.Name, &d.Host, &d.Port, &d.User, &encPwd, &d.IntervalSec, &d.ThresholdSec, &enabled, &d.CreatedAt, &d.UpdatedAt); err != nil {
			return nil, err
		}
		d.Password, _ = Decrypt(encPwd)
		d.Enabled = enabled == 1
		list = append(list, d)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) GetDatabase(id int64) (*Database, error) {
	var d Database
	var enabled int
	var encPwd string
	err := s.db.QueryRow(`SELECT id, name, host, port, user, password, interval_sec, threshold_sec, enabled, created_at, updated_at FROM databases WHERE id=?`, id).
		Scan(&d.ID, &d.Name, &d.Host, &d.Port, &d.User, &encPwd, &d.IntervalSec, &d.ThresholdSec, &enabled, &d.CreatedAt, &d.UpdatedAt)
	if err != nil {
		return nil, err
	}
	d.Password, _ = Decrypt(encPwd)
	d.Enabled = enabled == 1
	return &d, nil
}

func (s *Store) CreateDatabase(d *Database) (int64, error) {
	encPwd, err := Encrypt(d.Password)
	if err != nil {
		return 0, fmt.Errorf("encrypt password: %w", err)
	}
	res, err := s.db.Exec(`INSERT INTO databases (name, host, port, user, password, interval_sec, threshold_sec, enabled) VALUES (?,?,?,?,?,?,?,?)`,
		d.Name, d.Host, d.Port, d.User, encPwd, d.IntervalSec, d.ThresholdSec, boolToInt(d.Enabled))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateDatabase(d *Database) error {
	encPwd, err := Encrypt(d.Password)
	if err != nil {
		return fmt.Errorf("encrypt password: %w", err)
	}
	_, err = s.db.Exec(`UPDATE databases SET name=?, host=?, port=?, user=?, password=?, interval_sec=?, threshold_sec=?, enabled=?, updated_at=datetime('now') WHERE id=?`,
		d.Name, d.Host, d.Port, d.User, encPwd, d.IntervalSec, d.ThresholdSec, boolToInt(d.Enabled), d.ID)
	return err
}

// ToggleNotificationConfig 切换通知渠道启停。
func (s *Store) ToggleNotificationConfig(id int64) error {
	_, err := s.db.Exec(`UPDATE notification_configs SET enabled = 1 - enabled, updated_at = datetime('now') WHERE id = ?`, id)
	return err
}

func (s *Store) DeleteDatabase(id int64) error {
	// 级联会带走 custom_sql_checks，先把它们的告警事件清掉（9-02 删演练库
	// 时 19 条 firing 僵尸卡在告警页，就是漏了这一步）
	s.db.Exec(`DELETE FROM alert_events WHERE source = 'custom_sql'
		AND check_id IN (SELECT id FROM custom_sql_checks WHERE database_id = ?)`, id)
	_, err := s.db.Exec(`DELETE FROM databases WHERE id=?`, id)
	return err
}

func (s *Store) ToggleDatabase(id int64) error {
	_, err := s.db.Exec(`UPDATE databases SET enabled = 1 - enabled, updated_at=datetime('now') WHERE id=?`, id)
	return err
}

func (s *Store) CountDatabases() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM databases`).Scan(&count)
	return count, err
}

func (s *Store) CountEnabledDatabases() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM databases WHERE enabled=1`).Scan(&count)
	return count, err
}

// --- Notification Config CRUD ---

func (s *Store) ListNotificationConfigs() ([]NotificationConfig, error) {
	rows, err := s.db.Query(`SELECT id, database_id, scope_type, type, config_json, enabled, created_at, updated_at FROM notification_configs ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []NotificationConfig
	for rows.Next() {
		var nc NotificationConfig
		var enabled int
		var configStr string
		if err := rows.Scan(&nc.ID, &nc.DatabaseID, &nc.ScopeType, &nc.Type, &configStr, &enabled, &nc.CreatedAt, &nc.UpdatedAt); err != nil {
			return nil, err
		}
		nc.ConfigJSON = json.RawMessage(configStr)
		nc.Enabled = enabled == 1
		list = append(list, nc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

func (s *Store) GetNotificationConfig(id int64) (*NotificationConfig, error) {
	var nc NotificationConfig
	var enabled int
	var configStr string
	err := s.db.QueryRow(`SELECT id, database_id, scope_type, type, config_json, enabled, created_at, updated_at FROM notification_configs WHERE id=?`, id).
		Scan(&nc.ID, &nc.DatabaseID, &nc.ScopeType, &nc.Type, &configStr, &enabled, &nc.CreatedAt, &nc.UpdatedAt)
	if err != nil {
		return nil, err
	}
	nc.ConfigJSON = json.RawMessage(configStr)
	nc.Enabled = enabled == 1
	return &nc, nil
}

func (s *Store) CreateNotificationConfig(nc *NotificationConfig) (int64, error) {
	if nc.ScopeType == "" {
		nc.ScopeType = "all"
	}
	res, err := s.db.Exec(`INSERT INTO notification_configs (database_id, scope_type, type, config_json, enabled) VALUES (?,?,?,?,?)`,
		nc.DatabaseID, nc.ScopeType, nc.Type, string(nc.ConfigJSON), boolToInt(nc.Enabled))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateNotificationConfig(nc *NotificationConfig) error {
	if nc.ScopeType == "" {
		nc.ScopeType = "all"
	}
	_, err := s.db.Exec(`UPDATE notification_configs SET database_id=?, scope_type=?, type=?, config_json=?, enabled=?, updated_at=datetime('now') WHERE id=?`,
		nc.DatabaseID, nc.ScopeType, nc.Type, string(nc.ConfigJSON), boolToInt(nc.Enabled), nc.ID)
	return err
}

func (s *Store) DeleteNotificationConfig(id int64) error {
	_, err := s.db.Exec(`DELETE FROM notification_configs WHERE id=?`, id)
	return err
}

func (s *Store) GetEffectiveNotifications(databaseID int64) ([]NotificationConfig, error) {
	return s.GetScopedNotifications("mysql", databaseID)
}

// GetScopedNotifications returns notifications for a given scope type and ID.
// It returns scope-specific configs first, then global configs. Multiple enabled
// configs of the same type are all returned so every configured destination is tried.
func (s *Store) GetScopedNotifications(scopeType string, scopeID int64) ([]NotificationConfig, error) {
	rows, err := s.db.Query(`SELECT id, database_id, scope_type, type, config_json, enabled, created_at, updated_at FROM notification_configs WHERE enabled=1 AND ((scope_type=? AND (database_id=? OR database_id IS NULL)) OR scope_type='all') ORDER BY CASE WHEN scope_type='all' THEN 2 WHEN database_id IS NULL THEN 1 ELSE 0 END, id`, scopeType, scopeID)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []NotificationConfig
	for rows.Next() {
		var nc NotificationConfig
		var enabled int
		var configStr string
		if err := rows.Scan(&nc.ID, &nc.DatabaseID, &nc.ScopeType, &nc.Type, &configStr, &enabled, &nc.CreatedAt, &nc.UpdatedAt); err != nil {
			return nil, err
		}
		nc.ConfigJSON = json.RawMessage(configStr)
		nc.Enabled = enabled == 1
		list = append(list, nc)
	}
	if err := rows.Err(); err != nil {
		return nil, err
	}
	return list, nil
}

// --- Slow Query Log ---

func (s *Store) InsertSlowQueryLog(l *SlowQueryLog) (bool, error) {
	var lastID int64
	var lastSQL string
	err := s.db.QueryRow(`SELECT id, sql_text FROM slow_query_logs WHERE database_id=? AND process_id=? AND detected_at > datetime('now', '-1 hour') ORDER BY detected_at DESC LIMIT 1`, l.DatabaseID, l.ProcessID).Scan(&lastID, &lastSQL)
	if err == nil && lastSQL == l.SQLText {
		_, err = s.db.Exec(`UPDATE slow_query_logs SET thread_id=?, user=?, host=?, db_name=?, exec_sec=?, lock_sec=?, rows_examined=?, rows_sent=?, state=?, detected_at=datetime('now') WHERE id=?`,
			l.ThreadID, l.User, l.Host, l.DBName, l.ExecSec, l.LockSec, l.RowsExamined, l.RowsSent, l.State, lastID)
		return false, err
	}
	if err != nil && err != sql.ErrNoRows {
		return false, err
	}
	_, err = s.db.Exec(`INSERT INTO slow_query_logs (database_id, thread_id, process_id, user, host, db_name, sql_text, exec_sec, lock_sec, rows_examined, rows_sent, state) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)`,
		l.DatabaseID, l.ThreadID, l.ProcessID, l.User, l.Host, l.DBName, l.SQLText, l.ExecSec, l.LockSec, l.RowsExamined, l.RowsSent, l.State)
	if err != nil {
		return false, err
	}
	return true, nil
}

func (s *Store) ListSlowQueryLogs(databaseID *int64, page, pageSize int) ([]SlowQueryLog, int, error) {
	countQuery := `SELECT COUNT(*) FROM slow_query_logs`
	dataQuery := `SELECT l.id, l.database_id, COALESCE(d.name,''), l.thread_id, l.process_id, l.user, l.host, l.db_name, l.sql_text, l.exec_sec, l.lock_sec, l.rows_examined, l.rows_sent, l.state, l.detected_at FROM slow_query_logs l LEFT JOIN databases d ON l.database_id=d.id`
	var args []interface{}
	if databaseID != nil {
		countQuery += ` WHERE database_id=?`
		dataQuery += ` WHERE l.database_id=?`
		args = append(args, *databaseID)
	}

	var total int
	if err := s.db.QueryRow(countQuery, args...).Scan(&total); err != nil {
		return nil, 0, err
	}

	dataQuery += ` ORDER BY l.detected_at DESC LIMIT ? OFFSET ?`
	offset := (page - 1) * pageSize
	dataArgs := append(args, pageSize, offset)

	rows, err := s.db.Query(dataQuery, dataArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()

	var list []SlowQueryLog
	for rows.Next() {
		var l SlowQueryLog
		if err := rows.Scan(&l.ID, &l.DatabaseID, &l.DatabaseName, &l.ThreadID, &l.ProcessID, &l.User, &l.Host, &l.DBName, &l.SQLText, &l.ExecSec, &l.LockSec, &l.RowsExamined, &l.RowsSent, &l.State, &l.DetectedAt); err != nil {
			return nil, 0, err
		}
		list = append(list, l)
	}
	if err := rows.Err(); err != nil {
		return nil, 0, err
	}
	return list, total, nil
}

func (s *Store) ClearSlowQueryLogs(databaseID *int64) (int64, error) {
	if databaseID != nil {
		res, err := s.db.Exec(`DELETE FROM slow_query_logs WHERE database_id=?`, *databaseID)
		if err != nil {
			return 0, err
		}
		return res.RowsAffected()
	}
	res, err := s.db.Exec(`DELETE FROM slow_query_logs`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) PurgeOldLogs() (int64, error) {
	res, err := s.db.Exec(`DELETE FROM slow_query_logs WHERE detected_at < datetime('now', '-30 days')`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) StartPurgeLoop(ctx context.Context) {
	s.runPurge()
	go func() {
		ticker := time.NewTicker(1 * time.Hour)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				s.runPurge()
			}
		}
	}()
}

func (s *Store) runPurge() {
	if n, err := s.PurgeOldLogs(); err == nil && n > 0 {
		log.Printf("purged %d old slow query logs", n)
	}
	if n, err := s.PurgeOldHostSamples(); err == nil && n > 0 {
		log.Printf("purged %d old host samples", n)
	}
	if n, err := s.PurgeOldAuditLogs(); err == nil && n > 0 {
		log.Printf("purged %d old audit logs", n)
	}
	if n, err := s.PurgeOldHealthCheckLogs(); err == nil && n > 0 {
		log.Printf("purged %d old health check logs", n)
	}
	if n, err := s.PurgeOldCustomSQLLogs(); err == nil && n > 0 {
		log.Printf("purged %d old custom sql logs", n)
	}
	// 这两张表是随 Prometheus 采集与证书监控一起加的，当时漏了注册到这里，
	// 结果只进不出：实测 232 条采集规则一天写 28 万行、库一天涨到 59MB。
	if n, err := s.PurgeOldPromAlertLogs(); err == nil && n > 0 {
		log.Printf("purged %d old prom alert logs", n)
	}
	if n, err := s.PurgeOldCertCheckLogs(); err == nil && n > 0 {
		log.Printf("purged %d old cert check logs", n)
	}
	if n, err := s.PurgeOldAlertEvents(); err == nil && n > 0 {
		log.Printf("purged %d old alert events", n)
	}
	if n, err := s.PurgeOldMetricSamples(); err == nil && n > 0 {
		log.Printf("purged %d old metric samples", n)
	}
	s.CleanupOldNotifiedPIDs()
}

func (s *Store) CountSlowQueriesToday() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM slow_query_logs WHERE datetime(detected_at, 'localtime') >= date('now', 'localtime')`).Scan(&count)
	return count, err
}

func (s *Store) CountSlowQueriesWeek() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM slow_query_logs WHERE datetime(detected_at, 'localtime') >= date('now', 'localtime', '-7 days')`).Scan(&count)
	return count, err
}

func boolToInt(b bool) int {
	if b {
		return 1
	}
	return 0
}

// --- User CRUD ---

func (s *Store) CreateUser(u *User) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO users (username, github_id, github_login, avatar_url, role) VALUES (?,?,?,?,?)`,
		u.Username, u.GitHubID, u.GitHubLogin, u.AvatarURL, u.Role)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) GetUserByGitHubLogin(login string) (*User, error) {
	var u User
	err := s.db.QueryRow(`SELECT id, username, github_id, github_login, avatar_url, role, created_at FROM users WHERE github_login=?`, login).
		Scan(&u.ID, &u.Username, &u.GitHubID, &u.GitHubLogin, &u.AvatarURL, &u.Role, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) GetUserByGitHubID(ghID int64) (*User, error) {
	var u User
	err := s.db.QueryRow(`SELECT id, username, github_id, github_login, avatar_url, role, created_at FROM users WHERE github_id=?`, ghID).
		Scan(&u.ID, &u.Username, &u.GitHubID, &u.GitHubLogin, &u.AvatarURL, &u.Role, &u.CreatedAt)
	if err != nil {
		return nil, err
	}
	return &u, nil
}

func (s *Store) UpdateUserGitHub(id int64, ghID int64, ghLogin, avatarURL string) error {
	_, err := s.db.Exec(`UPDATE users SET github_id=?, github_login=?, avatar_url=? WHERE id=?`, ghID, ghLogin, avatarURL, id)
	return err
}

func (s *Store) ListUsers() ([]User, error) {
	rows, err := s.db.Query(`SELECT id, username, github_id, github_login, avatar_url, role, created_at FROM users ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []User
	for rows.Next() {
		var u User
		if err := rows.Scan(&u.ID, &u.Username, &u.GitHubID, &u.GitHubLogin, &u.AvatarURL, &u.Role, &u.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, u)
	}
	return list, rows.Err()
}

func (s *Store) DeleteUser(id int64) error {
	_, err := s.db.Exec(`DELETE FROM users WHERE id=?`, id)
	return err
}

func (s *Store) CountUsers() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM users`).Scan(&count)
	return count, err
}

// --- Settings ---

func (s *Store) GetSetting(key string) string {
	var val string
	if err := s.db.QueryRow(`SELECT value FROM settings WHERE key=?`, key).Scan(&val); err != nil {
		return ""
	}
	return val
}

func (s *Store) SetSetting(key, value string) error {
	_, err := s.db.Exec(`INSERT INTO settings (key, value) VALUES (?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value`, key, value)
	return err
}

func (s *Store) DeleteSettingsByPrefix(prefix string) error {
	if prefix == "" {
		return nil
	}
	_, err := s.db.Exec(`DELETE FROM settings WHERE key LIKE ?`, prefix+"%")
	return err
}

func (s *Store) GetAllSettings() map[string]string {
	m := make(map[string]string)
	rows, err := s.db.Query(`SELECT key, value FROM settings`)
	if err != nil {
		return m
	}
	defer rows.Close()
	for rows.Next() {
		var k, v string
		if err := rows.Scan(&k, &v); err == nil {
			m[k] = v
		}
	}
	return m
}

// --- RocketMQ Config CRUD ---

type RocketMQConfig struct {
	ID            int64     `json:"id"`
	Name          string    `json:"name"`
	DashboardURL  string    `json:"dashboard_url"`
	Username      string    `json:"username"`
	Password      string    `json:"password"`
	ConsumerGroup string    `json:"consumer_group"`
	Topic         string    `json:"topic"`
	Threshold     int       `json:"threshold"`
	IntervalSec   int       `json:"interval_sec"`
	NotifyNewMsg  bool      `json:"notify_new_msg"`
	Enabled       bool      `json:"enabled"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type RocketMQAlertLog struct {
	ID            int64     `json:"id"`
	ConfigID      int64     `json:"config_id"`
	ConfigName    string    `json:"config_name"`
	ConsumerGroup string    `json:"consumer_group"`
	Topic         string    `json:"topic"`
	DiffTotal     int64     `json:"diff_total"`
	MessageBody   string    `json:"message_body"`
	DetectedAt    time.Time `json:"detected_at"`
}

func (s *Store) ListRocketMQConfigs() ([]RocketMQConfig, error) {
	rows, err := s.db.Query(`SELECT id, name, dashboard_url, username, password, consumer_group, topic, threshold, interval_sec, notify_new_msg, enabled, created_at, updated_at FROM rocketmq_configs ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []RocketMQConfig
	for rows.Next() {
		var c RocketMQConfig
		var enabled, notifyNewMsg int
		var encPwd string
		if err := rows.Scan(&c.ID, &c.Name, &c.DashboardURL, &c.Username, &encPwd, &c.ConsumerGroup, &c.Topic, &c.Threshold, &c.IntervalSec, &notifyNewMsg, &enabled, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.Password, _ = Decrypt(encPwd)
		c.Enabled = enabled == 1
		c.NotifyNewMsg = notifyNewMsg == 1
		list = append(list, c)
	}
	return list, rows.Err()
}

func (s *Store) GetRocketMQConfig(id int64) (*RocketMQConfig, error) {
	var c RocketMQConfig
	var enabled, notifyNewMsg int
	var encPwd string
	err := s.db.QueryRow(`SELECT id, name, dashboard_url, username, password, consumer_group, topic, threshold, interval_sec, notify_new_msg, enabled, created_at, updated_at FROM rocketmq_configs WHERE id=?`, id).
		Scan(&c.ID, &c.Name, &c.DashboardURL, &c.Username, &encPwd, &c.ConsumerGroup, &c.Topic, &c.Threshold, &c.IntervalSec, &notifyNewMsg, &enabled, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}
	c.Password, _ = Decrypt(encPwd)
	c.Enabled = enabled == 1
	c.NotifyNewMsg = notifyNewMsg == 1
	return &c, nil
}

func (s *Store) CreateRocketMQConfig(c *RocketMQConfig) (int64, error) {
	encPwd, err := Encrypt(c.Password)
	if err != nil {
		return 0, fmt.Errorf("encrypt password: %w", err)
	}
	res, err := s.db.Exec(`INSERT INTO rocketmq_configs (name, dashboard_url, username, password, consumer_group, topic, threshold, interval_sec, notify_new_msg, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		c.Name, c.DashboardURL, c.Username, encPwd, c.ConsumerGroup, c.Topic, c.Threshold, c.IntervalSec, boolToInt(c.NotifyNewMsg), boolToInt(c.Enabled))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateRocketMQConfig(c *RocketMQConfig) error {
	encPwd, err := Encrypt(c.Password)
	if err != nil {
		return fmt.Errorf("encrypt password: %w", err)
	}
	_, err = s.db.Exec(`UPDATE rocketmq_configs SET name=?, dashboard_url=?, username=?, password=?, consumer_group=?, topic=?, threshold=?, interval_sec=?, notify_new_msg=?, enabled=?, updated_at=datetime('now') WHERE id=?`,
		c.Name, c.DashboardURL, c.Username, encPwd, c.ConsumerGroup, c.Topic, c.Threshold, c.IntervalSec, boolToInt(c.NotifyNewMsg), boolToInt(c.Enabled), c.ID)
	return err
}

func (s *Store) DeleteRocketMQConfig(id int64) error {
	_, err := s.db.Exec(`DELETE FROM rocketmq_configs WHERE id=?`, id)
	return err
}

func (s *Store) ToggleRocketMQ(id int64) error {
	_, err := s.db.Exec(`UPDATE rocketmq_configs SET enabled = 1 - enabled, updated_at=datetime('now') WHERE id=?`, id)
	return err
}

func (s *Store) InsertRocketMQAlertLog(l *RocketMQAlertLog) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO rocketmq_alert_logs (config_id, config_name, consumer_group, topic, diff_total, message_body) VALUES (?,?,?,?,?,?)`,
		l.ConfigID, l.ConfigName, l.ConsumerGroup, l.Topic, l.DiffTotal, l.MessageBody)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ListRocketMQAlertLogs(configID *int64, page, pageSize int) ([]RocketMQAlertLog, int, error) {
	countQ := `SELECT COUNT(*) FROM rocketmq_alert_logs`
	dataQ := `SELECT id, config_id, config_name, consumer_group, topic, diff_total, message_body, detected_at FROM rocketmq_alert_logs`
	var args []interface{}
	if configID != nil {
		countQ += ` WHERE config_id=?`
		dataQ += ` WHERE config_id=?`
		args = append(args, *configID)
	}
	var total int
	if err := s.db.QueryRow(countQ, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	dataQ += ` ORDER BY detected_at DESC LIMIT ? OFFSET ?`
	offset := (page - 1) * pageSize
	dataArgs := append(args, pageSize, offset)
	rows, err := s.db.Query(dataQ, dataArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var list []RocketMQAlertLog
	for rows.Next() {
		var l RocketMQAlertLog
		if err := rows.Scan(&l.ID, &l.ConfigID, &l.ConfigName, &l.ConsumerGroup, &l.Topic, &l.DiffTotal, &l.MessageBody, &l.DetectedAt); err != nil {
			return nil, 0, err
		}
		list = append(list, l)
	}
	return list, total, rows.Err()
}

func (s *Store) CountRocketMQConfigs() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM rocketmq_configs`).Scan(&count)
	return count, err
}

func (s *Store) CountRocketMQAlertsToday() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM rocketmq_alert_logs WHERE datetime(detected_at, 'localtime') >= date('now', 'localtime')`).Scan(&count)
	return count, err
}

func (s *Store) GetGlobalNotifications() ([]NotificationConfig, error) {
	rows, err := s.db.Query(`SELECT id, database_id, scope_type, type, config_json, enabled, created_at, updated_at FROM notification_configs WHERE enabled=1 AND scope_type='all'`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []NotificationConfig
	for rows.Next() {
		var nc NotificationConfig
		var enabled int
		var configStr string
		if err := rows.Scan(&nc.ID, &nc.DatabaseID, &nc.ScopeType, &nc.Type, &configStr, &enabled, &nc.CreatedAt, &nc.UpdatedAt); err != nil {
			return nil, err
		}
		nc.ConfigJSON = json.RawMessage(configStr)
		nc.Enabled = enabled == 1
		list = append(list, nc)
	}
	return list, rows.Err()
}

// --- Audit Logs ---

type AuditLog struct {
	ID        int64     `json:"id"`
	User      string    `json:"user"`
	Action    string    `json:"action"`
	Target    string    `json:"target"`
	TargetID  int64     `json:"target_id"`
	Detail    string    `json:"detail"`
	IP        string    `json:"ip"`
	CreatedAt time.Time `json:"created_at"`
}

func (s *Store) InsertAuditLog(l *AuditLog) {
	s.db.Exec(`INSERT INTO audit_logs (user, action, target, target_id, detail, ip) VALUES (?,?,?,?,?,?)`,
		l.User, l.Action, l.Target, l.TargetID, l.Detail, l.IP)
}

func (s *Store) ListAuditLogs(page, pageSize int) ([]AuditLog, int, error) {
	var total int
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM audit_logs`).Scan(&total); err != nil {
		return nil, 0, err
	}
	offset := (page - 1) * pageSize
	rows, err := s.db.Query(`SELECT id, user, action, target, target_id, detail, ip, created_at FROM audit_logs ORDER BY created_at DESC LIMIT ? OFFSET ?`, pageSize, offset)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var list []AuditLog
	for rows.Next() {
		var l AuditLog
		if err := rows.Scan(&l.ID, &l.User, &l.Action, &l.Target, &l.TargetID, &l.Detail, &l.IP, &l.CreatedAt); err != nil {
			return nil, 0, err
		}
		list = append(list, l)
	}
	return list, total, rows.Err()
}

func (s *Store) PurgeOldAuditLogs() (int64, error) {
	res, err := s.db.Exec(`DELETE FROM audit_logs WHERE created_at < datetime('now', '-90 days')`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

// --- Health Checks ---

type HealthCheck struct {
	ID                int64     `json:"id"`
	Name              string    `json:"name"`
	URL               string    `json:"url"`
	Method            string    `json:"method"`
	HeadersJSON       string    `json:"headers_json"`
	Body              string    `json:"body"`
	ExpectedStatus    int       `json:"expected_status"`
	ExpectedField     string    `json:"expected_field"`
	ExpectedValue     string    `json:"expected_value"`
	AlertField        string    `json:"alert_field"`
	AlertStrategy     string    `json:"alert_strategy"`
	AlertCondition    string    `json:"alert_condition"`
	AlertValue        string    `json:"alert_value"`
	AlertDeltaValue   string    `json:"alert_delta_value"`
	AlertDeltaPercent string    `json:"alert_delta_percent"`
	AlertConsecutive  int       `json:"alert_consecutive"`
	AlertRules        string    `json:"alert_rules"`
	TriggerActions    string    `json:"trigger_actions"`
	TimeoutSec        int       `json:"timeout_sec"`
	IntervalSec       int       `json:"interval_sec"`
	Enabled           bool      `json:"enabled"`
	CreatedAt         time.Time `json:"created_at"`
	UpdatedAt         time.Time `json:"updated_at"`
}

type HealthCheckLog struct {
	ID               int64     `json:"id"`
	CheckID          int64     `json:"check_id"`
	CheckName        string    `json:"check_name"`
	Status           string    `json:"status"`
	HTTPStatus       int       `json:"http_status"`
	Response         string    `json:"response"`
	Error            string    `json:"error"`
	DiagnosticOutput string    `json:"diagnostic_output"`
	LatencyMs        int64     `json:"latency_ms"`
	DetectedAt       time.Time `json:"detected_at"`
}

func (s *Store) ListHealthChecks() ([]HealthCheck, error) {
	rows, err := s.db.Query(`SELECT id, name, url, method, headers_json, body, expected_status, expected_field, expected_value, alert_field, alert_strategy, alert_condition, alert_value, alert_delta_value, alert_delta_percent, alert_consecutive, alert_rules, trigger_actions, timeout_sec, interval_sec, enabled, created_at, updated_at FROM health_checks ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []HealthCheck
	for rows.Next() {
		var h HealthCheck
		var enabled int
		if err := rows.Scan(&h.ID, &h.Name, &h.URL, &h.Method, &h.HeadersJSON, &h.Body, &h.ExpectedStatus, &h.ExpectedField, &h.ExpectedValue, &h.AlertField, &h.AlertStrategy, &h.AlertCondition, &h.AlertValue, &h.AlertDeltaValue, &h.AlertDeltaPercent, &h.AlertConsecutive, &h.AlertRules, &h.TriggerActions, &h.TimeoutSec, &h.IntervalSec, &enabled, &h.CreatedAt, &h.UpdatedAt); err != nil {
			return nil, err
		}
		normalizeHealthCheckDefaults(&h)
		h.Enabled = enabled == 1
		list = append(list, h)
	}
	return list, rows.Err()
}

func (s *Store) GetHealthCheck(id int64) (*HealthCheck, error) {
	var h HealthCheck
	var enabled int
	err := s.db.QueryRow(`SELECT id, name, url, method, headers_json, body, expected_status, expected_field, expected_value, alert_field, alert_strategy, alert_condition, alert_value, alert_delta_value, alert_delta_percent, alert_consecutive, alert_rules, trigger_actions, timeout_sec, interval_sec, enabled, created_at, updated_at FROM health_checks WHERE id=?`, id).
		Scan(&h.ID, &h.Name, &h.URL, &h.Method, &h.HeadersJSON, &h.Body, &h.ExpectedStatus, &h.ExpectedField, &h.ExpectedValue, &h.AlertField, &h.AlertStrategy, &h.AlertCondition, &h.AlertValue, &h.AlertDeltaValue, &h.AlertDeltaPercent, &h.AlertConsecutive, &h.AlertRules, &h.TriggerActions, &h.TimeoutSec, &h.IntervalSec, &enabled, &h.CreatedAt, &h.UpdatedAt)
	if err != nil {
		return nil, err
	}
	normalizeHealthCheckDefaults(&h)
	h.Enabled = enabled == 1
	return &h, nil
}

func (s *Store) CreateHealthCheck(h *HealthCheck) (int64, error) {
	normalizeHealthCheckDefaults(h)
	res, err := s.db.Exec(`INSERT INTO health_checks (name, url, method, headers_json, body, expected_status, expected_field, expected_value, alert_field, alert_strategy, alert_condition, alert_value, alert_delta_value, alert_delta_percent, alert_consecutive, alert_rules, trigger_actions, timeout_sec, interval_sec, enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		h.Name, h.URL, h.Method, h.HeadersJSON, h.Body, h.ExpectedStatus, h.ExpectedField, h.ExpectedValue, h.AlertField, h.AlertStrategy, h.AlertCondition, h.AlertValue, h.AlertDeltaValue, h.AlertDeltaPercent, h.AlertConsecutive, h.AlertRules, h.TriggerActions, h.TimeoutSec, h.IntervalSec, boolToInt(h.Enabled))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateHealthCheck(h *HealthCheck) error {
	normalizeHealthCheckDefaults(h)
	_, err := s.db.Exec(`UPDATE health_checks SET name=?, url=?, method=?, headers_json=?, body=?, expected_status=?, expected_field=?, expected_value=?, alert_field=?, alert_strategy=?, alert_condition=?, alert_value=?, alert_delta_value=?, alert_delta_percent=?, alert_consecutive=?, alert_rules=?, trigger_actions=?, timeout_sec=?, interval_sec=?, enabled=?, updated_at=datetime('now') WHERE id=?`,
		h.Name, h.URL, h.Method, h.HeadersJSON, h.Body, h.ExpectedStatus, h.ExpectedField, h.ExpectedValue, h.AlertField, h.AlertStrategy, h.AlertCondition, h.AlertValue, h.AlertDeltaValue, h.AlertDeltaPercent, h.AlertConsecutive, h.AlertRules, h.TriggerActions, h.TimeoutSec, h.IntervalSec, boolToInt(h.Enabled), h.ID)
	return err
}

func normalizeHealthCheckDefaults(h *HealthCheck) {
	if h.AlertStrategy == "" {
		h.AlertStrategy = "threshold"
	}
	if h.AlertCondition == "" {
		h.AlertCondition = "gt"
	}
	if h.AlertConsecutive <= 0 {
		h.AlertConsecutive = 1
	}
	if h.AlertRules == "" {
		h.AlertRules = "[]"
	}
	if h.TriggerActions == "" {
		h.TriggerActions = "[]"
	}
}

func (s *Store) DeleteHealthCheck(id int64) error {
	_, err := s.db.Exec(`DELETE FROM health_checks WHERE id=?`, id)
	if err == nil {
		s.db.Exec(`DELETE FROM alert_events WHERE source = 'health' AND check_id = ?`, id)
	}
	return err
}

func (s *Store) ToggleHealthCheck(id int64) error {
	_, err := s.db.Exec(`UPDATE health_checks SET enabled = 1 - enabled, updated_at = datetime('now') WHERE id=?`, id)
	return err
}

func (s *Store) InsertHealthCheckLog(l *HealthCheckLog) {
	// Only insert on state change; if same status as last record, just update timestamp.
	var lastStatus string
	var lastID int64
	err := s.db.QueryRow(`SELECT id, status FROM health_check_logs WHERE check_id=? ORDER BY detected_at DESC LIMIT 1`, l.CheckID).Scan(&lastID, &lastStatus)
	if err == nil && lastStatus == l.Status {
		s.db.Exec(`UPDATE health_check_logs SET http_status=?, response=?, error=?, diagnostic_output=CASE WHEN ? != '' THEN ? ELSE diagnostic_output END, latency_ms=?, detected_at=datetime('now') WHERE id=?`,
			l.HTTPStatus, l.Response, l.Error, l.DiagnosticOutput, l.DiagnosticOutput, l.LatencyMs, lastID)
		return
	}
	s.db.Exec(`INSERT INTO health_check_logs (check_id, check_name, status, http_status, response, error, diagnostic_output, latency_ms) VALUES (?,?,?,?,?,?,?,?)`,
		l.CheckID, l.CheckName, l.Status, l.HTTPStatus, l.Response, l.Error, l.DiagnosticOutput, l.LatencyMs)
}

func (s *Store) LastHealthCheckLogStatus(checkID int64) (string, bool, error) {
	var status string
	err := s.db.QueryRow(`SELECT status FROM health_check_logs WHERE check_id=? ORDER BY detected_at DESC LIMIT 1`, checkID).Scan(&status)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return status, true, nil
}

func (s *Store) ListHealthCheckLogs(checkID *int64, page, pageSize int) ([]HealthCheckLog, int, error) {
	var total int
	where := ""
	var args []any
	if checkID != nil {
		where = " WHERE check_id=?"
		args = append(args, *checkID)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM health_check_logs`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	offset := (page - 1) * pageSize
	queryArgs := append(args, pageSize, offset)
	rows, err := s.db.Query(`SELECT id, check_id, check_name, status, http_status, response, error, diagnostic_output, latency_ms, detected_at FROM health_check_logs`+where+` ORDER BY detected_at DESC LIMIT ? OFFSET ?`, queryArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var list []HealthCheckLog
	for rows.Next() {
		var l HealthCheckLog
		if err := rows.Scan(&l.ID, &l.CheckID, &l.CheckName, &l.Status, &l.HTTPStatus, &l.Response, &l.Error, &l.DiagnosticOutput, &l.LatencyMs, &l.DetectedAt); err != nil {
			return nil, 0, err
		}
		list = append(list, l)
	}
	return list, total, rows.Err()
}

func (s *Store) PurgeOldHealthCheckLogs() (int64, error) {
	res, err := s.db.Exec(`DELETE FROM health_check_logs WHERE detected_at < datetime('now', '-30 days')`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) CountHealthChecks() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM health_checks`).Scan(&count)
	return count, err
}

func (s *Store) CountHealthCheckErrorsToday() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM health_check_logs WHERE status != 'up' AND datetime(detected_at, 'localtime') >= date('now', 'localtime')`).Scan(&count)
	return count, err
}

// --- Grafana Config CRUD ---

type GrafanaConfig struct {
	ID            int64     `json:"id"`
	Name          string    `json:"name"`
	GrafanaURL    string    `json:"grafana_url"`
	Username      string    `json:"username"`
	Password      string    `json:"password"`
	DatasourceUID string    `json:"datasource_uid"`
	AutoRules     string    `json:"auto_rules"`
	WebhookURL    string    `json:"webhook_url"`
	WebhookSecret string    `json:"webhook_secret"`
	WebhookUID    string    `json:"webhook_uid"`
	FolderUID     string    `json:"folder_uid"`
	IntervalSec   int       `json:"interval_sec"`
	Enabled       bool      `json:"enabled"`
	CreatedAt     time.Time `json:"created_at"`
	UpdatedAt     time.Time `json:"updated_at"`
}

type GrafanaAlertLog struct {
	ID          int64      `json:"id"`
	ConfigID    int64      `json:"config_id"`
	ConfigName  string     `json:"config_name"`
	AlertName   string     `json:"alert_name"`
	Status      string     `json:"status"`
	Severity    string     `json:"severity"`
	Summary     string     `json:"summary"`
	Description string     `json:"description"`
	Fingerprint string     `json:"fingerprint"`
	LabelsJSON  string     `json:"labels_json"`
	StartsAt    time.Time  `json:"starts_at"`
	EndsAt      *time.Time `json:"ends_at"`
	DetectedAt  time.Time  `json:"detected_at"`
}

func (s *Store) ListGrafanaConfigs() ([]GrafanaConfig, error) {
	rows, err := s.db.Query(`SELECT id, name, grafana_url, username, password, datasource_uid, auto_rules, webhook_url, webhook_secret, webhook_uid, folder_uid, interval_sec, enabled, created_at, updated_at FROM grafana_configs ORDER BY id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []GrafanaConfig
	for rows.Next() {
		var c GrafanaConfig
		var enabled int
		var encPwd string
		if err := rows.Scan(&c.ID, &c.Name, &c.GrafanaURL, &c.Username, &encPwd, &c.DatasourceUID, &c.AutoRules, &c.WebhookURL, &c.WebhookSecret, &c.WebhookUID, &c.FolderUID, &c.IntervalSec, &enabled, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		c.Password, _ = Decrypt(encPwd)
		c.Enabled = enabled == 1
		list = append(list, c)
	}
	return list, rows.Err()
}

func (s *Store) GetGrafanaConfig(id int64) (*GrafanaConfig, error) {
	var c GrafanaConfig
	var enabled int
	var encPwd string
	err := s.db.QueryRow(`SELECT id, name, grafana_url, username, password, datasource_uid, auto_rules, webhook_url, webhook_secret, webhook_uid, folder_uid, interval_sec, enabled, created_at, updated_at FROM grafana_configs WHERE id = ?`, id).
		Scan(&c.ID, &c.Name, &c.GrafanaURL, &c.Username, &encPwd, &c.DatasourceUID, &c.AutoRules, &c.WebhookURL, &c.WebhookSecret, &c.WebhookUID, &c.FolderUID, &c.IntervalSec, &enabled, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}
	c.Password, _ = Decrypt(encPwd)
	c.Enabled = enabled == 1
	return &c, nil
}

func (s *Store) CreateGrafanaConfig(c *GrafanaConfig) (int64, error) {
	encPwd, _ := Encrypt(c.Password)
	res, err := s.db.Exec(`INSERT INTO grafana_configs (name, grafana_url, username, password, datasource_uid, auto_rules, webhook_url, webhook_secret, interval_sec, enabled) VALUES (?,?,?,?,?,?,?,?,?,?)`,
		c.Name, c.GrafanaURL, c.Username, encPwd, c.DatasourceUID, c.AutoRules, c.WebhookURL, c.WebhookSecret, c.IntervalSec, boolToInt(c.Enabled))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateGrafanaConfig(c *GrafanaConfig) error {
	encPwd, _ := Encrypt(c.Password)
	_, err := s.db.Exec(`UPDATE grafana_configs SET name=?, grafana_url=?, username=?, password=?, datasource_uid=?, auto_rules=?, webhook_url=?, webhook_secret=?, interval_sec=?, enabled=?, updated_at=datetime('now') WHERE id=?`,
		c.Name, c.GrafanaURL, c.Username, encPwd, c.DatasourceUID, c.AutoRules, c.WebhookURL, c.WebhookSecret, c.IntervalSec, boolToInt(c.Enabled), c.ID)
	return err
}

func (s *Store) DeleteGrafanaConfig(id int64) error {
	_, err := s.db.Exec(`DELETE FROM grafana_configs WHERE id = ?`, id)
	return err
}

func (s *Store) ToggleGrafana(id int64) error {
	_, err := s.db.Exec(`UPDATE grafana_configs SET enabled = 1 - enabled, updated_at = datetime('now') WHERE id = ?`, id)
	return err
}

func (s *Store) UpdateGrafanaProvisionUIDs(id int64, webhookUID, folderUID string) error {
	_, err := s.db.Exec(`UPDATE grafana_configs SET webhook_uid=?, folder_uid=?, updated_at=datetime('now') WHERE id=?`, webhookUID, folderUID, id)
	return err
}

func (s *Store) InsertGrafanaAlertLog(l *GrafanaAlertLog) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO grafana_alert_logs (config_id, config_name, alert_name, status, severity, summary, description, fingerprint, labels_json, starts_at, ends_at) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		l.ConfigID, l.ConfigName, l.AlertName, l.Status, l.Severity, l.Summary, l.Description, l.Fingerprint, l.LabelsJSON, l.StartsAt, l.EndsAt)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) ListGrafanaAlertLogs(configID *int64, page, pageSize int) ([]GrafanaAlertLog, int, error) {
	countQ := `SELECT COUNT(*) FROM grafana_alert_logs`
	dataQ := `SELECT id, config_id, config_name, alert_name, status, severity, summary, description, fingerprint, labels_json, starts_at, ends_at, detected_at FROM grafana_alert_logs`
	var args []interface{}
	if configID != nil {
		countQ += ` WHERE config_id = ?`
		dataQ += ` WHERE config_id = ?`
		args = append(args, *configID)
	}
	var total int
	if err := s.db.QueryRow(countQ, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	dataQ += ` ORDER BY detected_at DESC LIMIT ? OFFSET ?`
	rows, err := s.db.Query(dataQ, append(args, pageSize, (page-1)*pageSize)...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var list []GrafanaAlertLog
	for rows.Next() {
		var l GrafanaAlertLog
		if err := rows.Scan(&l.ID, &l.ConfigID, &l.ConfigName, &l.AlertName, &l.Status, &l.Severity, &l.Summary, &l.Description, &l.Fingerprint, &l.LabelsJSON, &l.StartsAt, &l.EndsAt, &l.DetectedAt); err != nil {
			return nil, 0, err
		}
		list = append(list, l)
	}
	return list, total, rows.Err()
}

func (s *Store) CountGrafanaConfigs() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM grafana_configs`).Scan(&count)
	return count, err
}

func (s *Store) CountGrafanaAlertsToday() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM grafana_alert_logs WHERE datetime(detected_at, 'localtime') >= date('now', 'localtime')`).Scan(&count)
	return count, err
}

func (s *Store) CountGrafanaRunning() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM grafana_configs WHERE enabled = 1`).Scan(&count)
	return count, err
}

// --- Custom SQL Checks ---

type CustomSQLCheck struct {
	ID                int64  `json:"id"`
	DatabaseID        int64  `json:"database_id"`
	DatabaseName      string `json:"database_name"`
	Name              string `json:"name"`
	DBName            string `json:"db_name"`
	SQLText           string `json:"sql_text"`
	ResultField       string `json:"result_field"`
	IntervalSec       int    `json:"interval_sec"`
	TimeoutSec        int    `json:"timeout_sec"`
	AlertStrategy     string `json:"alert_strategy"`
	Condition         string `json:"condition"`
	ExpectedValue     string `json:"expected_value"`
	AlertDeltaValue   string `json:"alert_delta_value"`
	AlertDeltaPercent string `json:"alert_delta_percent"`
	AlertConsecutive  int    `json:"alert_consecutive"`
	AlertRules        string `json:"alert_rules"`
	TriggerActions    string `json:"trigger_actions"`
	NotifyEnabled     bool   `json:"notify_enabled"`
	RecoveryNotify    bool   `json:"recovery_notify"`
	MessageTemplate   string `json:"message_template"`
	// DiagSQL 非空时，告警通知前在同一库执行它，把结果表附进通知——
	// 计数器型告警（如慢查询数增长）借此直接带出"具体是谁"（digest top 等）。
	DiagSQL   string    `json:"diag_sql"`
	Enabled   bool      `json:"enabled"`
	CreatedAt time.Time `json:"created_at"`
	UpdatedAt time.Time `json:"updated_at"`
}

type CustomSQLLog struct {
	ID            int64     `json:"id"`
	CheckID       int64     `json:"check_id"`
	CheckName     string    `json:"check_name"`
	DatabaseID    int64     `json:"database_id"`
	DatabaseName  string    `json:"database_name"`
	Status        string    `json:"status"`
	Value         string    `json:"value"`
	ExpectedValue string    `json:"expected_value"`
	Condition     string    `json:"condition"`
	Message       string    `json:"message"`
	Error         string    `json:"error"`
	DurationMs    int64     `json:"duration_ms"`
	DetectedAt    time.Time `json:"detected_at"`
}

func (s *Store) ListCustomSQLChecks() ([]CustomSQLCheck, error) {
	rows, err := s.db.Query(`SELECT c.id, c.database_id, COALESCE(d.name, ''), c.name, c.db_name, c.sql_text, c.result_field, c.interval_sec, c.timeout_sec, c.alert_strategy, c.condition, c.expected_value, c.alert_delta_value, c.alert_delta_percent, c.alert_consecutive, c.alert_rules, c.trigger_actions, c.notify_enabled, c.recovery_notify, c.message_template, c.diag_sql, c.enabled, c.created_at, c.updated_at FROM custom_sql_checks c LEFT JOIN databases d ON d.id=c.database_id ORDER BY c.id`)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []CustomSQLCheck
	for rows.Next() {
		var c CustomSQLCheck
		var notifyEnabled, recoveryNotify, enabled int
		if err := rows.Scan(&c.ID, &c.DatabaseID, &c.DatabaseName, &c.Name, &c.DBName, &c.SQLText, &c.ResultField, &c.IntervalSec, &c.TimeoutSec, &c.AlertStrategy, &c.Condition, &c.ExpectedValue, &c.AlertDeltaValue, &c.AlertDeltaPercent, &c.AlertConsecutive, &c.AlertRules, &c.TriggerActions, &notifyEnabled, &recoveryNotify, &c.MessageTemplate, &c.DiagSQL, &enabled, &c.CreatedAt, &c.UpdatedAt); err != nil {
			return nil, err
		}
		normalizeCustomSQLCheckDefaults(&c)
		c.NotifyEnabled = notifyEnabled == 1
		c.RecoveryNotify = recoveryNotify == 1
		c.Enabled = enabled == 1
		list = append(list, c)
	}
	return list, rows.Err()
}

func (s *Store) GetCustomSQLCheck(id int64) (*CustomSQLCheck, error) {
	var c CustomSQLCheck
	var notifyEnabled, recoveryNotify, enabled int
	err := s.db.QueryRow(`SELECT c.id, c.database_id, COALESCE(d.name, ''), c.name, c.db_name, c.sql_text, c.result_field, c.interval_sec, c.timeout_sec, c.alert_strategy, c.condition, c.expected_value, c.alert_delta_value, c.alert_delta_percent, c.alert_consecutive, c.alert_rules, c.trigger_actions, c.notify_enabled, c.recovery_notify, c.message_template, c.diag_sql, c.enabled, c.created_at, c.updated_at FROM custom_sql_checks c LEFT JOIN databases d ON d.id=c.database_id WHERE c.id=?`, id).
		Scan(&c.ID, &c.DatabaseID, &c.DatabaseName, &c.Name, &c.DBName, &c.SQLText, &c.ResultField, &c.IntervalSec, &c.TimeoutSec, &c.AlertStrategy, &c.Condition, &c.ExpectedValue, &c.AlertDeltaValue, &c.AlertDeltaPercent, &c.AlertConsecutive, &c.AlertRules, &c.TriggerActions, &notifyEnabled, &recoveryNotify, &c.MessageTemplate, &c.DiagSQL, &enabled, &c.CreatedAt, &c.UpdatedAt)
	if err != nil {
		return nil, err
	}
	c.NotifyEnabled = notifyEnabled == 1
	c.RecoveryNotify = recoveryNotify == 1
	c.Enabled = enabled == 1
	normalizeCustomSQLCheckDefaults(&c)
	return &c, nil
}

func (s *Store) CreateCustomSQLCheck(c *CustomSQLCheck) (int64, error) {
	normalizeCustomSQLCheckDefaults(c)
	res, err := s.db.Exec(`INSERT INTO custom_sql_checks (database_id, name, db_name, sql_text, result_field, interval_sec, timeout_sec, alert_strategy, condition, expected_value, alert_delta_value, alert_delta_percent, alert_consecutive, alert_rules, trigger_actions, notify_enabled, recovery_notify, message_template, diag_sql, enabled) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`,
		c.DatabaseID, c.Name, c.DBName, c.SQLText, c.ResultField, c.IntervalSec, c.TimeoutSec, c.AlertStrategy, c.Condition, c.ExpectedValue, c.AlertDeltaValue, c.AlertDeltaPercent, c.AlertConsecutive, c.AlertRules, c.TriggerActions, boolToInt(c.NotifyEnabled), boolToInt(c.RecoveryNotify), c.MessageTemplate, c.DiagSQL, boolToInt(c.Enabled))
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) UpdateCustomSQLCheck(c *CustomSQLCheck) error {
	normalizeCustomSQLCheckDefaults(c)
	_, err := s.db.Exec(`UPDATE custom_sql_checks SET database_id=?, name=?, db_name=?, sql_text=?, result_field=?, interval_sec=?, timeout_sec=?, alert_strategy=?, condition=?, expected_value=?, alert_delta_value=?, alert_delta_percent=?, alert_consecutive=?, alert_rules=?, trigger_actions=?, notify_enabled=?, recovery_notify=?, message_template=?, diag_sql=?, enabled=?, updated_at=datetime('now') WHERE id=?`,
		c.DatabaseID, c.Name, c.DBName, c.SQLText, c.ResultField, c.IntervalSec, c.TimeoutSec, c.AlertStrategy, c.Condition, c.ExpectedValue, c.AlertDeltaValue, c.AlertDeltaPercent, c.AlertConsecutive, c.AlertRules, c.TriggerActions, boolToInt(c.NotifyEnabled), boolToInt(c.RecoveryNotify), c.MessageTemplate, c.DiagSQL, boolToInt(c.Enabled), c.ID)
	return err
}

func normalizeCustomSQLCheckDefaults(c *CustomSQLCheck) {
	if c.AlertStrategy == "" {
		c.AlertStrategy = "threshold"
	}
	if c.Condition == "" {
		c.Condition = "gt"
	}
	if c.AlertConsecutive <= 0 {
		c.AlertConsecutive = 1
	}
	if c.AlertRules == "" {
		c.AlertRules = "[]"
	}
	if c.TriggerActions == "" {
		c.TriggerActions = "[]"
	}
}

func (s *Store) DeleteCustomSQLCheck(id int64) error {
	_, err := s.db.Exec(`DELETE FROM custom_sql_checks WHERE id=?`, id)
	if err == nil {
		s.db.Exec(`DELETE FROM alert_events WHERE source = 'custom_sql' AND check_id = ?`, id)
	}
	return err
}

func (s *Store) ToggleCustomSQLCheck(id int64) error {
	_, err := s.db.Exec(`UPDATE custom_sql_checks SET enabled = 1 - enabled, updated_at=datetime('now') WHERE id=?`, id)
	return err
}

func (s *Store) InsertCustomSQLLog(l *CustomSQLLog) (int64, error) {
	res, err := s.db.Exec(`INSERT INTO custom_sql_logs (check_id, check_name, database_id, database_name, status, value, expected_value, condition, message, error, duration_ms) VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
		l.CheckID, l.CheckName, l.DatabaseID, l.DatabaseName, l.Status, l.Value, l.ExpectedValue, l.Condition, l.Message, l.Error, l.DurationMs)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) LastCustomSQLLogStatus(checkID int64) (string, bool, error) {
	var status string
	err := s.db.QueryRow(`SELECT status FROM custom_sql_logs WHERE check_id=? ORDER BY detected_at DESC LIMIT 1`, checkID).Scan(&status)
	if err == sql.ErrNoRows {
		return "", false, nil
	}
	if err != nil {
		return "", false, err
	}
	return status, true, nil
}

func (s *Store) ListCustomSQLLogs(checkID *int64, page, pageSize int) ([]CustomSQLLog, int, error) {
	var total int
	where := ""
	var args []any
	if checkID != nil {
		where = " WHERE check_id=?"
		args = append(args, *checkID)
	}
	if err := s.db.QueryRow(`SELECT COUNT(*) FROM custom_sql_logs`+where, args...).Scan(&total); err != nil {
		return nil, 0, err
	}
	offset := (page - 1) * pageSize
	queryArgs := append(args, pageSize, offset)
	rows, err := s.db.Query(`SELECT id, check_id, check_name, database_id, database_name, status, value, expected_value, condition, message, error, duration_ms, detected_at FROM custom_sql_logs`+where+` ORDER BY detected_at DESC LIMIT ? OFFSET ?`, queryArgs...)
	if err != nil {
		return nil, 0, err
	}
	defer rows.Close()
	var list []CustomSQLLog
	for rows.Next() {
		var l CustomSQLLog
		if err := rows.Scan(&l.ID, &l.CheckID, &l.CheckName, &l.DatabaseID, &l.DatabaseName, &l.Status, &l.Value, &l.ExpectedValue, &l.Condition, &l.Message, &l.Error, &l.DurationMs, &l.DetectedAt); err != nil {
			return nil, 0, err
		}
		list = append(list, l)
	}
	return list, total, rows.Err()
}

func (s *Store) ClearCustomSQLLogs(checkID *int64) (int64, error) {
	if checkID != nil {
		res, err := s.db.Exec(`DELETE FROM custom_sql_logs WHERE check_id=?`, *checkID)
		if err != nil {
			return 0, err
		}
		return res.RowsAffected()
	}
	res, err := s.db.Exec(`DELETE FROM custom_sql_logs`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) PurgeOldCustomSQLLogs() (int64, error) {
	res, err := s.db.Exec(`DELETE FROM custom_sql_logs WHERE detected_at < datetime('now', '-30 days')`)
	if err != nil {
		return 0, err
	}
	return res.RowsAffected()
}

func (s *Store) CountCustomSQLChecks() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM custom_sql_checks`).Scan(&count)
	return count, err
}

func (s *Store) CountCustomSQLAlertsToday() (int, error) {
	var count int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM custom_sql_logs WHERE status='alert' AND datetime(detected_at, 'localtime') >= date('now', 'localtime')`).Scan(&count)
	return count, err
}

// --- Sessions ---

func (s *Store) SaveSession(sess *auth.SessionRow) error {
	_, err := s.db.Exec(`INSERT OR REPLACE INTO sessions (token, username, user_id, github_login, role, avatar_url, expires_at)
		VALUES (?, ?, ?, ?, ?, ?, ?)`,
		sess.Token, sess.Username, sess.UserID, sess.GitHubLogin, sess.Role, sess.AvatarURL, sess.ExpiresAt)
	return err
}

func (s *Store) GetSession(token string) (*auth.SessionRow, error) {
	row := s.db.QueryRow(`SELECT token, username, user_id, github_login, role, avatar_url, expires_at FROM sessions WHERE token = ?`, token)
	var sess auth.SessionRow
	if err := row.Scan(&sess.Token, &sess.Username, &sess.UserID, &sess.GitHubLogin, &sess.Role, &sess.AvatarURL, &sess.ExpiresAt); err != nil {
		return nil, err
	}
	return &sess, nil
}

func (s *Store) DeleteSession(token string) error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE token = ?`, token)
	return err
}

func (s *Store) CleanupExpiredSessions() error {
	_, err := s.db.Exec(`DELETE FROM sessions WHERE expires_at < datetime('now')`)
	return err
}

func (s *Store) UpdateSessionExpiry(token string, expiresAt time.Time) error {
	_, err := s.db.Exec(`UPDATE sessions SET expires_at = ? WHERE token = ?`, expiresAt, token)
	return err
}

// --- Notified PIDs ---

func (s *Store) IsProcessNotified(dbID int64, processID uint64, fingerprint string) bool {
	var storedFingerprint string
	err := s.db.QueryRow(`SELECT sql_fingerprint FROM notified_pids WHERE database_id=? AND process_id=?`, dbID, processID).Scan(&storedFingerprint)
	return err == nil && storedFingerprint == fingerprint
}

func (s *Store) MarkProcessNotified(dbID int64, processID uint64, fingerprint string) {
	if _, err := s.db.Exec(`INSERT INTO notified_pids (database_id, process_id, sql_fingerprint, notified_at) VALUES (?, ?, ?, datetime('now'))
		ON CONFLICT(database_id, process_id) DO UPDATE SET sql_fingerprint=excluded.sql_fingerprint, notified_at=datetime('now')`,
		dbID, processID, fingerprint); err != nil {
		log.Printf("mark notified pid failed db_id=%d process_id=%d: %v", dbID, processID, err)
	}
}

func (s *Store) ClearNotifiedPIDs(dbID int64, activeProcessIDs []uint64) {
	if len(activeProcessIDs) == 0 {
		if _, err := s.db.Exec(`DELETE FROM notified_pids WHERE database_id=?`, dbID); err != nil {
			log.Printf("clear notified pids failed db_id=%d: %v", dbID, err)
		}
		return
	}
	// Keep only active PIDs, remove stale ones
	placeholders := make([]string, len(activeProcessIDs))
	args := []any{dbID}
	for i, pid := range activeProcessIDs {
		placeholders[i] = "?"
		args = append(args, pid)
	}
	if _, err := s.db.Exec(`DELETE FROM notified_pids WHERE database_id=? AND process_id NOT IN (`+strings.Join(placeholders, ",")+`)`, args...); err != nil {
		log.Printf("clear stale notified pids failed db_id=%d: %v", dbID, err)
	}
}

func (s *Store) CleanupOldNotifiedPIDs() {
	if _, err := s.db.Exec(`DELETE FROM notified_pids WHERE notified_at < datetime('now', '-1 day')`); err != nil {
		log.Printf("cleanup old notified pids failed: %v", err)
	}
}

// --- Ignored SQL Patterns ---

type IgnoredSQLPattern struct {
	ID          int64     `json:"id"`
	DatabaseID  int64     `json:"database_id"`
	Fingerprint string    `json:"fingerprint"`
	SampleSQL   string    `json:"sample_sql"`
	CreatedAt   time.Time `json:"created_at"`
}

// NormalizeSQL replaces literal values in SQL with ? placeholders to create a fingerprint.
func NormalizeSQL(sql string) string {
	out := make([]byte, 0, len(sql))
	i := 0
	for i < len(sql) {
		ch := sql[i]
		// String literals: 'xxx' or "xxx"
		if ch == '\'' || ch == '"' {
			quote := ch
			i++
			for i < len(sql) {
				if sql[i] == '\\' {
					i += 2
					continue
				}
				if sql[i] == quote {
					i++
					break
				}
				i++
			}
			out = append(out, '?')
			continue
		}
		// Numbers (including decimals)
		if (ch >= '0' && ch <= '9') || (ch == '.' && i+1 < len(sql) && sql[i+1] >= '0' && sql[i+1] <= '9') {
			// Check that it's not part of an identifier
			if len(out) > 0 {
				prev := out[len(out)-1]
				if (prev >= 'a' && prev <= 'z') || (prev >= 'A' && prev <= 'Z') || prev == '_' {
					out = append(out, ch)
					i++
					continue
				}
			}
			for i < len(sql) && ((sql[i] >= '0' && sql[i] <= '9') || sql[i] == '.' || sql[i] == 'e' || sql[i] == 'E' || sql[i] == '+' || sql[i] == '-') {
				i++
			}
			out = append(out, '?')
			continue
		}
		out = append(out, ch)
		i++
	}
	// Collapse whitespace
	result := strings.Join(strings.Fields(string(out)), " ")
	return result
}

// NormalizeSQLForNotification keeps literal values so a reused process id with a
// different SQL text can notify again. It only trims and collapses whitespace.
func NormalizeSQLForNotification(sql string) string {
	return strings.Join(strings.Fields(strings.TrimSpace(sql)), " ")
}

func (s *Store) AddIgnoredSQL(databaseID int64, fingerprint, sampleSQL string) (int64, error) {
	res, err := s.db.Exec(`INSERT OR IGNORE INTO ignored_sql_patterns (database_id, fingerprint, sample_sql) VALUES (?, ?, ?)`,
		databaseID, fingerprint, sampleSQL)
	if err != nil {
		return 0, err
	}
	return res.LastInsertId()
}

func (s *Store) RemoveIgnoredSQL(id int64) error {
	_, err := s.db.Exec(`DELETE FROM ignored_sql_patterns WHERE id=?`, id)
	return err
}

func (s *Store) ListIgnoredSQL(databaseID *int64) ([]IgnoredSQLPattern, error) {
	query := `SELECT p.id, p.database_id, p.fingerprint, p.sample_sql, p.created_at FROM ignored_sql_patterns p`
	var args []interface{}
	if databaseID != nil {
		query += ` WHERE p.database_id=?`
		args = append(args, *databaseID)
	}
	query += ` ORDER BY p.created_at DESC`
	rows, err := s.db.Query(query, args...)
	if err != nil {
		return nil, err
	}
	defer rows.Close()
	var list []IgnoredSQLPattern
	for rows.Next() {
		var p IgnoredSQLPattern
		if err := rows.Scan(&p.ID, &p.DatabaseID, &p.Fingerprint, &p.SampleSQL, &p.CreatedAt); err != nil {
			return nil, err
		}
		list = append(list, p)
	}
	return list, rows.Err()
}

func (s *Store) IsSQLIgnored(databaseID int64, fingerprint string) bool {
	var n int
	err := s.db.QueryRow(`SELECT 1 FROM ignored_sql_patterns WHERE database_id=? AND fingerprint=?`, databaseID, fingerprint).Scan(&n)
	return err == nil
}

func (s *Store) InitDefaultSettings() {
	defaults := map[string]string{
		"password_login_enabled":  "1",
		"github_enabled":          "0",
		"show_rocketmq_menu":      "1",
		"show_grafana_menu":       "1",
		"show_cloud_logging_menu": "1",
	}
	for k, v := range defaults {
		if s.GetSetting(k) == "" {
			s.SetSetting(k, v)
		}
	}
}

// CountEnabledNotifications 给总览页"系统自身健康"用：0 = 告警发不出去。
func (s *Store) CountEnabledNotifications() (int, error) {
	var n int
	err := s.db.QueryRow(`SELECT COUNT(*) FROM notification_configs WHERE enabled = 1`).Scan(&n)
	return n, err
}
