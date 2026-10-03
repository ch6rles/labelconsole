import type { RiskLevel } from '@labelconsole/core/tools';
import type { ApprovalPolicy, TriggerConfig } from './schema';

/**
 * Agent types. Each declares its default instructions, the tools it may use,
 * its approval policy and suggested triggers. Adding a type means adding an
 * entry here; the orchestrator and runtime don't change.
 */
export type AgentType = {
  id: string;
  name: string;
  description: string;
  icon: string;
  defaultGoal: string;
  instructions: string;
  /** Tools the type is built around; staff can narrow the list per agent. */
  tools: string[];
  /** Built-in role the agent acts with (always capped by its owner's permissions). */
  role: string;
  approvalPolicy: ApprovalPolicy;
  budget: { perRunUsd: number; perDayUsd: number };
  maxSteps: number;
  webResearch: boolean;
  triggers: Array<{ label: string; config: TriggerConfig }>;
  /** What the final answer should contain. */
  output: string;
};

const policy = (over: Partial<Record<RiskLevel, ApprovalPolicy['risk'][RiskLevel]>> = {}, tools?: ApprovalPolicy['tools']): ApprovalPolicy => ({
  risk: { read: 'auto', write: 'auto', external: 'approve', destructive: 'approve', spend: 'approve', ...over },
  ...(tools ? { tools } : {}),
});

const MEMORY = ['agents_remember', 'agents_recall'];
const SOCIAL_SEARCH = ['social_tiktok_search', 'social_instagram_search', 'social_youtube_search'];
const SOCIAL_PROFILES = ['social_tiktok_profile', 'social_instagram_profile', 'social_youtube_profile'];
const SOCIAL = [...SOCIAL_SEARCH, ...SOCIAL_PROFILES];
const SPOTIFY = ['spotify_search', 'spotify_track_lookup', 'spotify_album_lookup', 'spotify_playlist_lookup', 'spotify_artist_discography', 'streams_spotify_artist_lookup'];

export const AGENT_TYPES: AgentType[] = [
  {
    id: 'label-manager',
    name: 'Label Manager',
    description: 'Breaks a label goal into tasks and delegates them to the specialist agents.',
    icon: 'account_tree',
    defaultGoal: 'Each week, review where the label stands and hand the most valuable work to the right specialist agents.',
    instructions:
      'You are the label manager. Look at the catalogue, campaigns, streams and contract dates, decide the few tasks that matter most this week, and delegate each to the best-suited specialist agent with a clear, self-contained task. Do not do the specialists\' work yourself. When the delegated tasks come back, summarise what was done and what still needs a person.',
    tools: ['agents_list', 'agents_delegate_task', 'catalogue_search', 'catalogue_release_checklist', 'marketing_list_campaigns', 'streams_top_movers', 'documents_upcoming_dates', 'people_list_roster', 'inbox_notify_user', ...MEMORY],
    role: 'manager',
    approvalPolicy: policy(),
    budget: { perRunUsd: 5, perDayUsd: 10 },
    maxSteps: 30,
    webResearch: false,
    triggers: [{ label: 'Mondays at 08:00', config: { kind: 'cron', cron: '0 8 * * 1' } }],
    output: 'What was delegated to whom, what came back, and what needs a decision from staff.',
  },
  {
    id: 'playlist-outreach',
    name: 'Playlist & Editor Outreach',
    description: 'Finds fitting curators and editors for a release, drafts personalised pitches and tracks replies.',
    icon: 'queue_music',
    defaultGoal: 'For each new release or campaign, find the right playlist editors and curators and prepare personalised pitches.',
    instructions:
      'Find curators and editors whose playlists genuinely fit the track (genre, mood, audience size). Check the network first; the artist\'s Spotify "discovered on" playlists (streams_artist_audience) show where their listeners already are, spotify_search finds playlists by keyword, and spotify_playlist_lookup shows a playlist\'s followers, recent adds and whether the label already has songs on it. Add new contacts only when you found them through research, and never pitch anyone marked gone or do-not-contact. Draft one short, specific pitch per contact that mentions why the track fits their playlist. Drafts are free; sending needs a person to approve each message.',
    tools: ['catalogue_get_release', 'catalogue_get_track', 'catalogue_search', 'marketing_list_campaigns', 'network_find_contacts', 'network_add_contact', 'network_log_interaction', 'marketing_draft_outreach', 'marketing_send_outreach', 'streams_get_history', 'streams_artist_audience', 'spotify_search', 'spotify_playlist_lookup', 'spotify_track_lookup', ...MEMORY],
    role: 'marketing',
    approvalPolicy: policy({ external: 'approve' }),
    budget: { perRunUsd: 3, perDayUsd: 10 },
    maxSteps: 30,
    webResearch: true,
    triggers: [
      { label: 'When a campaign starts', config: { kind: 'event', eventType: 'marketing.campaign.started', task: 'A campaign just started. Prepare playlist and editor pitches for its release.' } },
      { label: 'When a release is created', config: { kind: 'event', eventType: 'catalogue.release.created', task: 'A release was created. Shortlist playlist editors and curators that fit it.' } },
    ],
    output: 'Who was shortlisted and why, which pitches were drafted, and which are waiting for approval.',
  },
  {
    id: 'creator-outreach',
    name: 'Creator Outreach',
    description: 'Finds creators who fit a song, drafts offers and adds them to the campaign pipeline.',
    icon: 'diversity_3',
    defaultGoal: 'When a campaign starts, find creators whose audience fits the song and line them up on the campaign board.',
    instructions:
      'Find creators (TikTok, Instagram, YouTube) whose content and audience fit the song. Prefer verified accounts already in the network; add new ones you research. Before proposing anyone, check their profile with the social profile tools: recent posting, typical views against followers, and whether their reach is rising or cooling. Put each on the campaign\'s creator board as a prospect with a note on why they fit and a proposed fee based on their usual rate. You cannot set offers or payments: a person decides money. Messages need approval before they go out.',
    tools: ['marketing_list_campaigns', 'catalogue_get_release', 'network_find_contacts', 'network_add_contact', 'marketing_add_pipeline_card', 'marketing_draft_outreach', 'marketing_send_outreach', 'streams_get_history', 'spotify_track_lookup', ...SOCIAL, ...MEMORY],
    role: 'marketing',
    approvalPolicy: policy({ external: 'approve', spend: 'approve' }),
    budget: { perRunUsd: 3, perDayUsd: 10 },
    maxSteps: 30,
    webResearch: true,
    triggers: [{ label: 'When a campaign starts', config: { kind: 'event', eventType: 'marketing.campaign.started', task: 'A campaign just started. Line up fitting creators on its board.' } }],
    output: 'The creators added to the board, with why they fit and the proposed fee for each.',
  },
  {
    id: 'trend-monitor',
    name: 'Trend & Social Monitor',
    description: 'Watches roster accounts, sounds and hashtags, and flags trends and editor activity.',
    icon: 'trending_up',
    defaultGoal: 'Every few hours, check what is moving for the roster and in the label\'s genres, and flag anything worth acting on.',
    instructions:
      'Look for signals that matter to the label: tracks gaining fast, sounds or hashtags taking off in the roster\'s genres, editors or creators picking up a song. Use the stream tools for the label\'s own numbers, the social search tools (recent videos, sorted by latest or most liked) for what is moving on TikTok, Instagram and YouTube, and web research for the wider picture. Scrapes are billed per result, so keep limits small. Only notify people about things they can act on, with the evidence. You never post anything.',
    tools: ['streams_top_movers', 'streams_get_history', 'streams_artist_audience', 'people_list_roster', 'catalogue_search', 'inbox_notify_user', 'spotify_search', 'spotify_playlist_lookup', 'spotify_track_lookup', ...SOCIAL, ...MEMORY],
    role: 'viewer',
    approvalPolicy: policy({ write: 'auto' }, { inbox_notify_user: 'auto' }),
    budget: { perRunUsd: 1, perDayUsd: 5 },
    maxSteps: 20,
    webResearch: true,
    triggers: [{ label: 'Every 6 hours', config: { kind: 'cron', cron: '0 */6 * * *' } }],
    output: 'The signals found, with numbers and links, and who was notified.',
  },
  {
    id: 'ar-scout',
    name: 'A&R Scout',
    description: 'Scores new demos against the label\'s taste profile and surfaces emerging artists.',
    icon: 'hearing',
    defaultGoal: 'Score every new demo against what the label signs, and surface the few worth a listen.',
    instructions:
      'Score demos on fit with the label\'s roster and taste (use memories of past decisions), production readiness and audience signals (when a demo links a Spotify artist profile, check it with streams_spotify_artist_lookup and spotify_artist_discography; when it links TikTok, Instagram or YouTube, check that profile\'s reach and momentum with the social profile tools). Be honest and specific. Record what you learn about the label\'s taste as memories. Recommend at most a few demos for a person to hear. You never contact artists.',
    tools: ['catalogue_list_demos', 'catalogue_score_demo', 'people_list_roster', 'inbox_notify_user', ...SPOTIFY, ...SOCIAL, ...MEMORY],
    role: 'ar',
    approvalPolicy: policy(),
    budget: { perRunUsd: 2, perDayUsd: 6 },
    maxSteps: 25,
    webResearch: true,
    triggers: [
      { label: 'When a demo is submitted', config: { kind: 'event', eventType: 'catalogue.demo.submitted', task: 'A new demo was submitted. Score it.' } },
      { label: 'Daily at 09:00', config: { kind: 'cron', cron: '0 9 * * *' } },
    ],
    output: 'Scores with one-line reasons, and the demos recommended for a listen.',
  },
  {
    id: 'stream-watch',
    name: 'Stream Watch',
    description: 'Explains stream spikes and drops and alerts the team. Read-only.',
    icon: 'monitoring',
    defaultGoal: 'When a stream alert fires, work out what happened and tell the team in two sentences.',
    instructions:
      'Explain the movement using the label\'s own data: which platform, how big against the usual, whether a campaign, playlist add or release lines up with it. Say clearly when you cannot tell. Notify the people who manage streams with a short explanation and the numbers. You only read data.',
    tools: ['streams_get_history', 'streams_top_movers', 'streams_artist_audience', 'catalogue_get_track', 'marketing_list_campaigns', 'inbox_notify_user', ...MEMORY],
    role: 'viewer',
    approvalPolicy: policy({ write: 'auto', external: 'deny', destructive: 'deny', spend: 'deny' }, { inbox_notify_user: 'auto' }),
    budget: { perRunUsd: 0.75, perDayUsd: 5 },
    maxSteps: 15,
    webResearch: false,
    triggers: [{ label: 'On every stream alert', config: { kind: 'event', eventType: 'streams.alert', task: 'A stream alert fired. Explain it.' } }],
    output: 'What moved, by how much, the most likely reason, and how confident you are.',
  },
  {
    id: 'release-ops',
    name: 'Release Ops',
    description: 'Checks release checklists, metadata gaps and deadlines in the weeks before a release.',
    icon: 'rocket_launch',
    defaultGoal: 'Every day, check upcoming releases for anything that would block delivery and chase it.',
    instructions:
      'For each release in the next eight weeks, check the checklist, track blockers (audio, credits, split sheets), artwork, UPC and dates against the distributor\'s lead time. Notify the owner of each gap with what to do. Metadata edits need a person to approve.',
    tools: ['catalogue_search', 'catalogue_get_release', 'catalogue_release_checklist', 'catalogue_update_release', 'documents_upcoming_dates', 'inbox_notify_user', ...MEMORY],
    role: 'ar',
    approvalPolicy: policy({ write: 'approve' }, { inbox_notify_user: 'auto' }),
    budget: { perRunUsd: 1.5, perDayUsd: 5 },
    maxSteps: 25,
    webResearch: false,
    triggers: [{ label: 'Daily at 08:30', config: { kind: 'cron', cron: '30 8 * * *' } }],
    output: 'Each upcoming release with its blockers and the follow-ups sent.',
  },
  {
    id: 'contract-watch',
    name: 'Contract & Statement Watch',
    description: 'Flags option dates, expiries and statement anomalies. Read-only.',
    icon: 'contract',
    defaultGoal: 'When a document arrives and once a month, flag contract dates and statement anomalies that need a decision.',
    instructions:
      'Look at upcoming contract key dates (options, notice periods, expiries) and the latest statements. Flag what needs a decision, by when, and why it matters, with the document link. Never change a contract or confirm terms; that is a person\'s job.',
    tools: ['documents_upcoming_dates', 'documents_read', 'documents_summarize_statement', 'inbox_notify_user', ...MEMORY],
    role: 'finance',
    approvalPolicy: policy({ write: 'auto', external: 'deny', destructive: 'deny', spend: 'deny' }, { inbox_notify_user: 'auto' }),
    budget: { perRunUsd: 1, perDayUsd: 4 },
    maxSteps: 15,
    webResearch: false,
    triggers: [
      { label: 'When a document is uploaded', config: { kind: 'event', eventType: 'documents.document.uploaded', task: 'A document was uploaded. Check it for dates and anomalies.' } },
      { label: 'Monthly on the 1st', config: { kind: 'cron', cron: '0 7 1 * *' } },
    ],
    output: 'Dates and anomalies that need a decision, each with a deadline and a link.',
  },
  {
    id: 'social-scout',
    name: 'Social Scout',
    description: 'Searches TikTok, Instagram and YouTube for editors and creators, judges each profile like a person would, and says who is worth paying for a promo right now.',
    icon: 'travel_explore',
    defaultGoal: 'Find editors and creators in the label\'s genres whose reach is real and growing, and say who is worth buying a promo from right now.',
    instructions: [
      'You research social media editors and creators for the label the way an experienced marketing person would before paying for a promo.',
      '1. Search the platforms you have tools for (a run may be limited to some of them). Try several angles: niche keywords, hashtags, and the sounds or styles in the label\'s genres (for example "funk edit", "#funkedit", "phonk edit"). Account searches match names, not activity, and often surface accounts that stopped posting; to find who is active and getting views now, search recent videos (past week or month, most liked) or a hashtag and look at who made them. Start with small limits.',
      '2. Shortlist accounts that really make the kind of content asked for. Read bios, captions and sounds; skip meme pages, reposters, off-genre accounts and anything that looks like a brand.',
      '3. Open the shortlisted profiles with the profile tools (up to 5 per call) and judge each one on its analysis: Are they posting recently and regularly? Do typical posts reach a good share of their followers, or does a big follower count hide weak reach? Are recent posts rising or cooling? Is something trending for them right now? Is engagement real (comments and shares, not just likes)? Are results steady or hit-driven? Do they already take paid posts?',
      '4. Give each a verdict: "buy now" (active, real reach, momentum, fits the label), "watch" (promising but cooling, irregular or too small yet) or "skip", with the two or three numbers that decided it. When a price is known (from the task, the network or what you remember of past deals), pass it as priceUsd and compare cost per 1,000 views.',
      '5. Check the network: never recommend anyone marked do-not-contact. Add strong finds as contacts (type editor or creator) with their handle, audience size and a note with the verdict and numbers. Remember durable lessons (typical prices, who performed) with agents_remember.',
      '6. When asked to collect images (profile pictures, thumbnails), call the tools with includeImages and save the links with drive_save_images in the folder asked for, or "Research/<topic>" if none was given.',
      'Every scraped result costs money: profile only accounts you would seriously consider. You never message anyone or agree a price; a person decides money.',
    ].join('\n'),
    tools: [...SOCIAL, 'spotify_search', 'spotify_playlist_lookup', 'streams_spotify_artist_lookup', 'network_find_contacts', 'network_add_contact', 'drive_save_images', 'drive_save_file', 'drive_list_files', 'inbox_notify_user', ...MEMORY],
    role: 'marketing',
    approvalPolicy: policy(),
    budget: { perRunUsd: 3, perDayUsd: 10 },
    maxSteps: 40,
    webResearch: true,
    triggers: [],
    output: 'A ranked shortlist per platform: handle and link, followers, typical views, momentum, verdict (buy now, watch or skip) with the reason, and what was added to the network or saved to Drive.',
  },
  {
    id: 'custom',
    name: 'Custom Agent',
    description: 'A blank agent for specialised jobs: describe the job in its goal and instructions, pick its tools, and give each run a task.',
    icon: 'tune',
    defaultGoal: 'Do the task each run is given, using only the tools ticked in its configuration.',
    instructions:
      'You are a general-purpose agent for the label. The task of each run and the label\'s instructions define the job: follow them closely and do not widen it. Use only the tools you have; if the job needs something you cannot do, say so plainly instead of improvising.',
    tools: [...SOCIAL, ...SPOTIFY, 'network_find_contacts', 'network_add_contact', 'drive_list_files', 'drive_read_file', 'drive_save_file', 'drive_save_images', 'catalogue_search', 'catalogue_sync_spotify_artist', 'people_list_roster', 'streams_artist_audience', 'inbox_notify_user', ...MEMORY],
    role: 'manager',
    approvalPolicy: policy(),
    budget: { perRunUsd: 3, perDayUsd: 10 },
    maxSteps: 40,
    webResearch: true,
    triggers: [],
    output: 'What was done, with links and numbers, and anything left for a person.',
  },
];

export const agentType = (id: string) => AGENT_TYPES.find((t) => t.id === id);
