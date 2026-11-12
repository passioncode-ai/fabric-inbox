/**
 * B-246 D-1 (docs/app-store/tasks/2026-11-12-inbox-agent-grants.md): what each agent tool needs from a grant. Every
 * tool is named here once, so a new tool fails `tests/mcp-grants.test.ts` until someone decides what it needs. A
 * mailbox capability is checked on the mailboxes the tool reaches; "server" is an act on the whole server, which only a
 * grant on every mailbox ("*") with every capability gives (today's Admin key and administrators).
 */
import type { Capability } from "./grants";

export type ToolNeed = Capability | "server";

const ofEach = (need: ToolNeed, names: string): [string, ToolNeed][] => names.trim().split(/\s+/).map((n) => [n, need]);

export const TOOL_NEEDS: Readonly<Record<string, ToolNeed>> = Object.freeze(Object.fromEntries([
  // Reading mail, the server's lists and its reports; changes nothing.
  ...ofEach("read", `list_accounts list_messages search_mailbox list_mailbox_messages read_message read_thread get_attachment
    list_held_messages list_folders get_send_status list_addresses check_address_routing list_domains get_spam_settings
    list_agents list_agent_runs get_agent_outcomes list_open_questions list_agent_events list_event_hooks list_agent_threads
    get_agent_status agent_mail_volume list_answers_to_grade get_judge_calibration get_support_months get_support_topics
    list_agent_evals list_categories list_knowledge search_knowledge list_rules list_drafts read_draft list_discard_rules
    get_server check_address rename_status check_test_message list_cloudflare_accounts list_campaigns get_campaign
    list_campaign_recipients preview_campaign dry_run_campaign list_suppression campaign_report`),
  // Drafts, kept for a person or sent later.
  ...ofEach("draft", "save_draft delete_draft answer_again"),
  // Sending mail now.
  ...ofEach("send", "send_draft send_email reply forward approve_rule_run"),
  // Sorting mail without sending or destroying it.
  ...ofEach("organize", `update_messages move_messages label_messages mark_spam discard_messages restore_discarded sync_account
    refresh_inbox mark_category_seen manage_folder dismiss_rule_run check_rule_run`),
  // Deleting mail for good (its two-call code stays).
  ...ofEach("delete", "delete_message"),
  // Campaigns: prepared, queued and sent through their own caps (R-6).
  ...ofEach("campaign", "save_campaign delete_campaign add_campaign_recipients change_suppression pause_campaign stop_campaign launch_campaign"),
  // An address's life on this server.
  ...ofEach("create", `create_address create_addresses update_address pause_address resume_address rename_address cancel_rename
    import_mailbox move_address route_address_here bring_address_here set_catch_all`),
  ...ofEach("remove", "remove_address"),
  // The reply agents of the mailboxes, their knowledge, categories and the held messages they raise.
  ...ofEach("agents", `decide_held_message add_event_hook remove_event_hook set_agent_status judge_bench grade_agent_answer
    preview_agent_answer save_agent_eval remove_agent_eval run_agent_evals set_account_agent save_agent delete_agent
    save_category delete_category save_project delete_project save_knowledge_collection delete_knowledge_collection
    put_knowledge_documents delete_knowledge_document`),
  // The whole server: domains, Cloudflare, spam and discard settings, rules, setup, providers, people, keys, its health.
  ...ofEach("server", `connect_domain release_domain enable_domain_sending add_forward_destination remove_forward_destination
    show_cloudflare_account remove_cloudflare_account update_spam_list empty_spam clear_incoming_failures remove_discard_rule
    update_discard_allow_list set_hidden_addresses save_rule dry_run_rule retry_incoming apply_setup disconnect_gmail
    disconnect_account create_credential_key save_member remove_member sync_member_sign_in create_agent_key revoke_agent_key
    send_test_message get_server_errors get_ops_digest get_storage check_spam list_members list_audit export_mailbox
    export_setup list_mail_providers gmail_connect_link gmail_setup_status check_gmail_setup outlook_connect_link
    connect_account set_account_password set_provider_setup microsoft_setup_status check_microsoft_setup list_agent_keys
    list_agent_activity list_grants grant_access revoke_grant`),
]));
