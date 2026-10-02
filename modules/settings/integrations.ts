/** Third-party connections a label can configure. Secrets go to the vault, never back to the browser. */
export type IntegrationField = { name: string; label: string; secret?: boolean; hint?: string; optional?: boolean };
/** `platformKey` names the environment variable that serves labels without their own key. */
export type Integration = { provider: string; name: string; icon: string; description: string; fields: IntegrationField[]; usedBy: string[]; docs?: string; platformKey?: 'ANTHROPIC_API_KEY' | 'VOYAGE_API_KEY' | 'YOUTUBE_API_KEY' | 'SPOTSCRAPER_API_KEY' | 'APIFY_API_TOKEN' };

export const INTEGRATIONS: Integration[] = [
  {
    provider: 'anthropic',
    name: 'Anthropic (Claude)',
    icon: 'smart_toy',
    description: 'Runs agents and contract-term extraction. Without a label key, the platform key is used and billed on your plan.',
    fields: [
      { name: 'apiKey', label: 'API key', secret: true },
      { name: 'workspaceId', label: 'Workspace ID', optional: true, hint: 'Only for a personal key that isn’t scoped to one workspace (wrkspc_…, from Console → Settings → Workspaces)' },
    ],
    usedBy: ['Agents', 'Documents'],
    docs: 'https://platform.claude.com/settings/keys',
    platformKey: 'ANTHROPIC_API_KEY',
  },
  {
    provider: 'voyage',
    name: 'Voyage AI (embeddings)',
    icon: 'hub',
    description: 'Embeddings for agent memory, so agents recall what they learned by meaning and not only by matching words. Anthropic’s recommended embedding provider. Existing memories are embedded in the background once a key is added.',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
    usedBy: ['Agents'],
    docs: 'https://dash.voyageai.com',
    platformKey: 'VOYAGE_API_KEY',
  },
  {
    provider: 'youtube',
    name: 'YouTube Data API',
    icon: 'smart_display',
    description: 'Official view counts for YouTube Music art tracks and official videos. Polling uses videos.list (1 quota unit per 50 videos); search runs once per track to find its videos.',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
    usedBy: ['Streams', 'Catalogue'],
    docs: 'https://console.cloud.google.com/apis/library/youtube.googleapis.com',
    platformKey: 'YOUTUBE_API_KEY',
  },
  {
    provider: 'spotscraper',
    name: 'SpotScraper (Spotify data)',
    icon: 'equalizer',
    description: 'Spotify play counts for stream tracking, track credits, ISRC search, release details, artist monthly listeners and playlist follower counts. Billed by SpotScraper per request. Agents only see numbers the app derives, never SpotScraper responses.',
    fields: [{ name: 'apiKey', label: 'API key', secret: true }],
    usedBy: ['Streams', 'Catalogue', 'People', 'Network'],
    docs: 'https://spotscraper.readme.io',
    platformKey: 'SPOTSCRAPER_API_KEY',
  },
  {
    provider: 'apify',
    name: 'Apify (TikTok, Instagram, YouTube)',
    icon: 'travel_explore',
    description: 'Lets agents research creators and editors: search TikTok, Instagram and YouTube, read profiles and recent posts, and judge whether someone is trending. Apify bills per result on your Apify account.',
    fields: [{ name: 'apiKey', label: 'API token', secret: true }],
    usedBy: ['Agents', 'Network'],
    docs: 'https://console.apify.com/settings/integrations',
    platformKey: 'APIFY_API_TOKEN',
  },
  {
    provider: 'spotify',
    name: 'Spotify Web API',
    icon: 'graphic_eq',
    description: 'ISRC and UPC lookup for metadata, only where your access level allows (a commercial product needs extended access). Not used for stream counts, and Spotify responses are never sent to agents.',
    fields: [
      { name: 'clientId', label: 'Client ID' },
      { name: 'clientSecret', label: 'Client secret', secret: true },
    ],
    usedBy: ['Catalogue'],
    docs: 'https://developer.spotify.com/dashboard',
  },
  {
    provider: 'apple_music',
    name: 'Apple Music API',
    icon: 'music_note',
    description: 'ISRC, UPC, record label and copyright lines, using a MusicKit developer token.',
    fields: [
      { name: 'developerToken', label: 'Developer token (JWT)', secret: true },
      { name: 'storefront', label: 'Storefront', optional: true, hint: 'Two-letter country, default us' },
    ],
    usedBy: ['Catalogue'],
    docs: 'https://developer.apple.com/documentation/applemusicapi',
  },
  {
    provider: 'licensed_streams',
    name: 'Licensed stream data provider',
    icon: 'query_stats',
    description: 'Spotify and other DSP stream counts from a licensed vendor, chosen after a pricing and terms review (SaaS and AI-agent use must be allowed). The adapter is ready for the vendor you pick.',
    fields: [
      { name: 'vendor', label: 'Vendor' },
      { name: 'baseUrl', label: 'API base URL' },
      { name: 'apiKey', label: 'API key', secret: true },
    ],
    usedBy: ['Streams', 'Catalogue'],
  },
  {
    provider: 'google_drive',
    name: 'Google Drive',
    icon: 'add_to_drive',
    description: 'Mirror Google Drive folders into the label Drive. Uses an OAuth client and a refresh token with drive.readonly scope.',
    fields: [
      { name: 'clientId', label: 'OAuth client ID' },
      { name: 'clientSecret', label: 'OAuth client secret', secret: true },
      { name: 'refreshToken', label: 'Refresh token', secret: true },
    ],
    usedBy: ['Drive'],
    docs: 'https://developers.google.com/drive/api/guides/about-auth',
  },
  {
    provider: 'smtp',
    name: 'Email (SMTP)',
    icon: 'mail',
    description: 'Sends invitations, date reminders and approved outreach from your own mailbox or email provider.',
    fields: [
      { name: 'host', label: 'SMTP host' },
      { name: 'port', label: 'Port', hint: '587 (STARTTLS) or 465 (TLS)' },
      { name: 'username', label: 'Username' },
      { name: 'password', label: 'Password', secret: true },
      { name: 'from', label: 'From address', hint: 'e.g. Northline Records <ar@northline.fm>' },
    ],
    usedBy: ['Settings', 'Marketing', 'Agents'],
  },
  {
    provider: 'streams_webhook',
    name: 'Stream data webhook',
    icon: 'webhook',
    description: 'After every poll and statement import, new stream readings are POSTed as one JSON batch to your URL, signed with HMAC-SHA256 in the X-LabelConsole-Signature header.',
    fields: [
      { name: 'url', label: 'Endpoint URL', hint: 'https:// only' },
      { name: 'secret', label: 'Signing secret', secret: true, hint: 'Any long random string; verify the signature with it' },
    ],
    usedBy: ['Streams'],
  },
];

export const integrationFor = (provider: string) => INTEGRATIONS.find((i) => i.provider === provider);
