export interface Site {
  id: string;
  name: string;
  url: string;
  desc?: string;
  icon?: string;
  category?: string;
}

export interface SiteAdmin extends Site {
  enabled?: boolean;
  order?: number;
  total?: number;
  today?: number;
  createdAt?: string;
  linkStatus?: 'ok' | 'dead' | 'unknown';
  linkDetail?: string;
  linkCheckedAt?: string;
}

export interface Features {
  announcements: boolean;
  qqGroups: boolean;
  comments: boolean;
  feedback: boolean;
  countdown: boolean;
  friendlinks: boolean;
  popular: boolean;
  visitorStats: boolean;
  lucky: boolean;
  recent: boolean;
  download: boolean;
  shareCodes: boolean;
}

export interface SiteInfo {
  siteName: string;
  allowRegister: boolean;
  firstRun: boolean;
  loginCaptcha: boolean;
  role: UserRole | null;
  roleLabel: string;
  announcement: string;
  announcementCount: number;
  logo: string;
  accentColor: string;
  background: string;
  footerText: string;
  weatherEnabled: boolean;
  quoteEnabled: boolean;
  f12Block: boolean;
  features: Features;
  limits: { commentMaxLen: number; feedbackMaxLen: number };
}

export type UserRole = 'owner' | 'admin' | 'user' | 'guest';

export interface CurrentUser {
  username: string;
  role: UserRole;
  roleLabel?: string;
}

export interface Announcement {
  id: string;
  title: string;
  content: string;
  pinned: boolean;
  updatedAt?: string;
  startAt?: string;
  endAt?: string;
}

export interface QqGroup {
  id: string;
  name: string;
  url: string;
  order?: number;
}

export interface FriendLink {
  id: string;
  name: string;
  url: string;
  order?: number;
  createdAt?: string;
}

export interface Countdown {
  id: string;
  name: string;
  date: string;
  createdAt?: string;
}

export interface CommentItem {
  id: string;
  nick: string;
  content: string;
  createdAt: string;
  reply?: string;
  replyBy?: string;
  replyAt?: string;
  ip?: string;
}

export interface FeedbackItem {
  id: string;
  contact: string;
  content: string;
  createdAt: string;
  ip?: string;
  status?: 'open' | 'processing' | 'resolved';
  reply?: string;
  replyBy?: string;
  replyAt?: string;
}

export interface ShareFile {
  id: string;
  name: string;
  size: number;
  desc?: string;
  downloads: number;
  createdAt: string;
  external?: boolean;
  nodeId?: string;
}

export interface Folder {
  id: string;
  name: string;
  parentId: string;
}

export interface WeatherInfo {
  enabled: boolean;
  error?: string;
  city?: string;
  desc?: string;
  temp?: string | number;
  feelsLike?: string | number;
  humidity?: string | number;
  windKmph?: string | number;
  stale?: boolean;
}

export interface StatusDay {
  date: string;
  uptime: number | null;
  down: number | null;
}

export interface StatusComponent {
  id: string;
  name: string;
  url: string;
  description: string;
  type: string;
  typeLabel: string;
  status: 'up' | 'down' | 'degraded' | 'paused' | 'unknown';
  statusLabel: string;
  uptime: number | null;
  interval: number;
  latency: number | null;
  lastChecked: string;
  createdAt: string;
  days: StatusDay[];
  error: string;
}

export interface StatusIncident {
  id: string;
  monitorId: string;
  monitorName: string;
  type: string;
  startedAt: string;
  duration: number;
  ongoing: boolean;
  reason: string;
}

export interface StatusPayload {
  source: string;
  configured: boolean;
  name: string;
  days: number;
  checkedAt: string;
  fetchedAt: string;
  status: 'operational' | 'degraded' | 'outage' | 'unknown';
  statusLabel: string;
  summary: {
    total: number;
    up: number;
    down: number;
    degraded: number;
    paused: number;
    unknown: number;
    uptime: number | null;
  };
  components: StatusComponent[];
  incidents: StatusIncident[];
  error: string;
  warning: string;
  cacheAge?: number;
}

export interface Monitor {
  id: string;
  name: string;
  url: string;
  description: string;
  enabled: boolean;
  retryOnFail: boolean;
  order: number;
  status: string;
  statusCode: number;
  latency: number | null;
  lastChecked: string;
  error?: string;
  createdAt: string;
}

export interface AdminStats {
  totals: {
    sites: number;
    visits: number;
    today: number;
    todayVisitors: number;
    users: number;
    files: number;
    fileDownloads: number;
  };
  ranking: { id: string; name: string; url: string; total: number; today: number }[];
  trend: { date: string; total: number }[];
  visitorTrend: { date: string; total: number }[];
  heatmap: { date: string; hours: number[] }[];
  fileRanking: { id: string; name: string; size: number; downloads: number; createdAt: string }[];
  referrers: { host: string; count: number }[];
  deadLinks: { id: string; name: string; url: string; detail: string; checkedAt: string }[];
}

export interface AdminSettings {
  siteName: string;
  allowRegister: boolean;
  loginCaptcha: boolean;
  announcement: string;
  logo: string;
  accentColor: string;
  background: string;
  footerText: string;
  weatherEnabled: boolean;
  weatherCity: string;
  quoteEnabled: boolean;
  linkCheckEnabled: boolean;
  linkCheckInterval: number;
  acDomesticBlock: boolean;
  acOverseasBlock: boolean;
  acDatacenterBlock: boolean;
  acDcAutoClose: boolean;
  acF12Block: boolean;
  acF12AutoClose: boolean;
  blockTitle: string;
  blockContent: string;
  blockFontSize: number;
  blockTextWrap: boolean;
  announcementsEnabled: boolean;
  qqGroupsEnabled: boolean;
  commentsEnabled: boolean;
  feedbackEnabled: boolean;
  countdownEnabled: boolean;
  friendlinksEnabled: boolean;
  popularEnabled: boolean;
  visitorStatsEnabled: boolean;
  luckyEnabled: boolean;
  recentEnabled: boolean;
  downloadEnabled: boolean;
  shareCodesEnabled: boolean;
  commentMaxLen: number;
  feedbackMaxLen: number;
  popularTopN: number;
  shareDefaultTtlHours: number;
  downloadRateMbps: number;
  fileMaxMb: number;
  maxAttempts: number;
  banDurationMin: number;
  heatmapDays: number;
}

export interface AdminFile {
  id: string;
  name: string;
  storage?: string;
  size: number;
  desc?: string;
  downloads: number;
  hidden?: boolean;
  speedLimitMbps?: number;
  folderId?: string;
  sourceUrl?: string;
  nodeId?: string;
  uploadedBy?: string;
  createdAt: string;
}

export interface LoginLog {
  time: string;
  username: string;
  ip: string;
  result: string;
  detail: string;
}

export interface OpLog {
  time: string;
  user: string;
  ip: string;
  action: string;
  detail: string;
  category?: string;
}

export interface LogsResponse {
  list: (LoginLog | OpLog)[];
  total: number;
  page: number;
  pageSize: number;
  timezone: string;
}

export interface AdminUser {
  id: string;
  username: string;
  createdAt: string;
  createdBy: string;
  role: UserRole;
  roleLabel: string;
  self: boolean;
}

export interface BanRecord {
  ip: string;
  failCount: number;
  banUntil: string;
  lastFail: string;
}

export interface SessionRecord {
  id: string;
  username: string;
  ip: string;
  createdAt: string;
  expiresAt: string;
  self: boolean;
}

export interface NodeRecord {
  id: string;
  name: string;
  baseUrl: string;
  enabled: boolean;
  online: boolean;
  lastHeartbeat: number;
  capacityMbps: number;
  freeBandwidthMbps: number;
  activeTasks: number;
  peers: string[];
  files: number;
  createdAt: string;
}

export interface ShareCode {
  code: string;
  url: string;
  expiresAt: string;
  createdBy: string;
}
