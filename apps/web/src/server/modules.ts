import 'server-only';
import { registerModules, type ModuleServer } from '@labelconsole/core/modules';
import type { ModuleWeb } from '@labelconsole/core/web';
import agentsServer from '@labelconsole/agents/server';
import agentsWeb from '@labelconsole/agents/web';
import catalogueServer from '@labelconsole/catalogue/server';
import catalogueWeb from '@labelconsole/catalogue/web';
import documentsServer from '@labelconsole/documents/server';
import documentsWeb from '@labelconsole/documents/web';
import driveServer from '@labelconsole/drive/server';
import driveWeb from '@labelconsole/drive/web';
import inboxServer from '@labelconsole/inbox/server';
import inboxWeb from '@labelconsole/inbox/web';
import marketingServer from '@labelconsole/marketing/server';
import marketingWeb from '@labelconsole/marketing/web';
import networkServer from '@labelconsole/network/server';
import networkWeb from '@labelconsole/network/web';
import peopleServer from '@labelconsole/people/server';
import peopleWeb from '@labelconsole/people/web';
import settingsServer from '@labelconsole/settings/server';
import settingsWeb from '@labelconsole/settings/web';
import streamsServer from '@labelconsole/streams/server';
import streamsWeb from '@labelconsole/streams/web';

/** Every module the console ships. Order is irrelevant: nav order comes from manifests. */
export const serverModules: ModuleServer[] = [peopleServer, driveServer, networkServer, catalogueServer, documentsServer, streamsServer, marketingServer, agentsServer, inboxServer, settingsServer];
export const webModules: ModuleWeb[] = [peopleWeb, driveWeb, networkWeb, catalogueWeb, documentsWeb, streamsWeb, marketingWeb, agentsWeb, inboxWeb, settingsWeb];

// Idempotent: every bundle that imports this file registers into the shared registry.
registerModules(serverModules);
