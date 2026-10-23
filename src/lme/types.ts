/**
 * スナップショット（エルメから取り出した生データ）の型。
 * 公式MCP・公開APIの応答をできるだけそのまま保持し、解釈は mapping 側で行う。
 */

export interface LmeBot {
  id: string; // MCP の bot_id（ハッシュ）
  line_id?: string; // "@xxxx"
  view_name?: string;
  total_friend?: number;
  liff_app_id?: string;
}

export interface LmeTag {
  id: number;
  name: string;
  friend_count?: number;
  created_at?: string | null;
}

export interface LmeFieldOption {
  option_id?: number;
  label: string;
}

export interface LmeField {
  id: number; // 負=標準、正=カスタム
  title: string;
  type: string; // TEXT / POINT / DATE / SELECT（API）または input/calendar/select（MCP）
  options?: LmeFieldOption[] | null;
}

export interface LmeHandlingStatus {
  id: number;
  name: string;
}

/** 友だち一覧の1行（MCP list_friends / API /friends を統合） */
export interface LmeFriendRow {
  lmessage_friend_id: number;
  line_friend_id: string;
  line_name: string | null;
  system_name?: string | null;
  email?: string | null;
  phone?: string | null;
  is_blocked?: boolean | null;
  followed_at?: string | null; // MCP
  blocked_at?: string | null;
  added_time?: string | null; // API（日付のみ）
}

export interface LmeFriendTag {
  tag_id: number;
  tag_name?: string;
  added_at?: string | null;
}

export interface LmeFriendInfoValue {
  id: number;
  name?: string;
  title?: string;
  type?: string;
  value: unknown;
}

export interface LmeFriendScenarioState {
  id?: number; // API 形式
  scenario_id?: number; // MCP 形式
  name?: string;
  scenario_name?: string;
  status: string; // following / completed / stopped
  started_at?: string | null;
  ended_at?: string | null;
}

export interface LmeFriendDetail {
  lmessage_friend_id: number;
  line_friend_id: string;
  line_name?: string | null;
  system_name?: string | null;
  email?: string | null;
  phone?: string | null;
  is_blocked?: boolean | null;
  followed_at?: string | null;
  blocked_at?: string | null;
  memo?: unknown[];
  tags: LmeFriendTag[];
  friend_info: LmeFriendInfoValue[];
  scenarios: LmeFriendScenarioState[];
  purchase_history?: unknown[];
  booking_history?: unknown;
}

export interface LmeMessage {
  message_id?: number;
  sender: "friend" | "bot"; // 正規化済み（API: friend/LINE_OA、MCP: user?/bot）
  sender_name?: string | null;
  message_type: string;
  content: unknown; // text は string、template は [{type,content}]、メディアは URL 等
  source?: unknown;
  sent_at: string;
}

export interface LmeConversation {
  lmessage_friend_id: number;
  line_friend_id?: string;
  handling_status?: LmeHandlingStatus | null;
  confirm_status?: string | null; // read / unread
  display_status?: string | null;
  block_status?: string | null;
  favorite?: string | null;
  last_message_date?: string | null;
  messages: LmeMessage[];
  complete: boolean; // 全履歴を取り切れたか（API は直近100件のみ）
}

/** 会話一覧の 1 人分（conversation_index.json。確認状態・対応ステータス・最終メッセージ日時） */
export interface LmeConversationIndexEntry {
  confirm_status: string | null;
  handling_status: LmeHandlingStatus | null;
  last_message_date: string | null;
}

/** 1人分のスナップショット（friends/<id>.json） */
export interface LmeFriendSnapshot {
  row: LmeFriendRow;
  detail: LmeFriendDetail | null;
  conversation: LmeConversation | null;
  fetched_at: string;
}

export interface LmeScenarioListItem {
  id: number;
  name: string;
  count_follow?: number;
  count_stop?: number;
  count_unfinish?: number;
  folder_id?: number;
  created_at?: string;
}

export interface LmeScenarioStepTemplate {
  id: number;
  name?: string | null;
  type: string; // text / image / ...
  content?: unknown;
}

export interface LmeAction {
  id?: number | null;
  action_id?: number | null;
  type: string; // tag / text / template / scenario / ...
  content?: string;
  data?: Record<string, unknown>;
}

export interface LmeScenarioStep {
  id: number;
  name?: string | null;
  order_number: number;
  delay_type: string; // immediate / date_based / time_based(?)
  start_day?: number | null;
  start_time?: string | null; // "12:32:00"
  delay_minutes?: number | null;
  templates: LmeScenarioStepTemplate[];
  send_count?: number;
  filters?: unknown[];
  actions?: LmeAction[];
  raw?: unknown;
}

export interface LmeScenarioDetail extends LmeScenarioListItem {
  steps: LmeScenarioStep[];
}

export interface LmeTemplateListItem {
  id: number;
  name: string;
  type: string; // group / text / image / ...
  category_id: number;
  category_name: string;
  content?: string; // group の場合は子テンプレートID CSV
}

export interface LmeTemplateDetail {
  id: number;
  name?: string | null;
  type: string;
  category_id?: number;
  content?: unknown;
  data?: Record<string, unknown>;
  children?: LmeTemplateDetail[]; // group を展開したもの
  updated_at?: string;
}

export interface LmeFormField {
  id: number;
  type: string; // text / text_new / select / date_time / friend_info_file / ...
  name?: string;
  label?: string;
  title?: string;
  help?: string;
  rules?: string; // JSON 文字列
  settings?: string | null; // JSON 文字列
  position?: number;
  placeholder?: string;
}

export interface LmeFormPage {
  page_id: number;
  button_submit_name?: string;
  fields: LmeFormField[];
}

export interface LmeFormDetail {
  id: number;
  name: string;
  title?: string;
  description?: string;
  form_type?: string;
  unique_key?: string;
  count_user_reply?: number;
  actions_on_open?: LmeAction[];
  actions_on_reply?: LmeAction[];
  pages: LmeFormPage[];
  created_at?: string;
}

export interface LmeFormAnswer {
  name: string;
  type: string;
  value: unknown;
}

export interface LmeFormResponse {
  id: number;
  lmessage_friend_id: number;
  line_friend_id?: string;
  line_name?: string;
  answers: LmeFormAnswer[];
  duration?: string;
  answered_at: string;
}

export interface LmeAutoReplyKeyword {
  id?: number;
  keyword: string;
  match_type: string; // partial / exact
}

export interface LmeAutoReply {
  id: number;
  trigger_by: string; // keyword / any_message
  keywords: LmeAutoReplyKeyword[];
  keyword_logic?: string;
  time_mode?: string;
  time_setting?: unknown;
  is_stopped: boolean;
  filters?: unknown[];
  actions?: LmeAction[];
  created_at?: string;
}

export interface LmeWelcomeMessage {
  type: "add_new" | "add_old" | "unblock";
  message: string | null;
  actions: LmeAction[];
  raw?: unknown;
}

export interface LmeRichMenu {
  id: number;
  group_id?: number;
  name: string;
  title_menu?: string;
  width?: number;
  height?: number;
  layout?: string;
  url_image?: string;
  friend_count?: number;
  detail?: unknown; // get_richmenu_detail
}

export interface LmeTrafficSource {
  id: number;
  name: string;
  code: string;
  total_user_click?: number;
  total_user_friend?: number;
  actions?: LmeAction[];
  created_at?: string;
}

export interface LmeSalon {
  id: number;
  calendar_name?: string;
  detail?: unknown;
  bookings?: unknown[];
}

export interface SnapshotMeta {
  version: 1;
  bot: LmeBot;
  started_at: string;
  finished_at?: string;
  sources: { api: boolean; mcp: boolean };
  friend_total?: number;
  notes: string[];
}
