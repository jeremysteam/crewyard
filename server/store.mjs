import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

const empty = () => ({
  users: [], authIdentities: [], sessions: [], workspaces: [], agents: [], agentInvites: [], projects: [], goals: [],
  jobs: [], jobRequests: [], scopeProposals: [], comments: [], votes: [], mentions: [], activity: [], folderPairings: [], folders: [],
  announcements: [], meetings: [], meetingRounds: [], meetingResponses: [], meetingVotes: [], meetingMemories: [], nextActivityId: 1,
});

export function createStore(filePath) {
  let queue = Promise.resolve();

  async function load() {
    try { return { ...empty(), ...JSON.parse(await readFile(filePath, 'utf8')) }; }
    catch (error) { if (error.code === 'ENOENT') return empty(); throw error; }
  }

  async function save(data) {
    await mkdir(dirname(filePath), { recursive: true });
    const tmp = `${filePath}.${process.pid}.tmp`;
    await writeFile(tmp, JSON.stringify(data, null, 2));
    await rename(tmp, filePath);
  }

  return {
    read: async (fn) => { await queue; return fn(await load()); },
    write: (fn) => {
      const result = queue.then(async () => {
        const data = await load();
        const value = await fn(data);
        await save(data);
        return value;
      });
      queue = result.catch(() => {});
      return result;
    },
  };
}
