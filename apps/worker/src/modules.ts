import { registerModules, type ModuleServer } from '@labelconsole/core/modules';
import agents from '@labelconsole/agents/server';
import catalogue from '@labelconsole/catalogue/server';
import documents from '@labelconsole/documents/server';
import drive from '@labelconsole/drive/server';
import inbox from '@labelconsole/inbox/server';
import marketing from '@labelconsole/marketing/server';
import network from '@labelconsole/network/server';
import people from '@labelconsole/people/server';
import settings from '@labelconsole/settings/server';
import streams from '@labelconsole/streams/server';

export const serverModules: ModuleServer[] = [people, drive, network, catalogue, documents, streams, marketing, agents, inbox, settings];
registerModules(serverModules);
