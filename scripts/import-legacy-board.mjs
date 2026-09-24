// One-time local pilot import. Reads the original board over its HTTP API and
// writes only to the isolated CommonGround test workspace through its API.
import { createHash } from 'node:crypto';

const sourceOrigin = 'http://127.0.0.1:4321';
const targetOrigin = 'http://127.0.0.1:4322';
const sourceProjectId = 13;
const sourceProjectName = 'Music Video Generator — Song Understanding First';
const targetEmail = 'jeremy.test@commonground.invalid';
const targetWorkspaceName = 'Music Video Pilot';
const rootName = 'Music Video Generator';
const featureName = 'Song Understanding First';
const apply = process.argv.includes('--apply');

async function request(origin, path, { method = 'GET', body, cookie, token } = {}) {
  const headers = {};
  if (body !== undefined) headers['content-type'] = 'application/json';
  if (cookie) headers.cookie = cookie;
  if (token) headers.authorization = `Bearer ${token}`;
  const response = await fetch(`${origin}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    redirect: 'error',
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) throw new Error(`${method} ${path} failed (${response.status}): ${value.error || 'unknown error'}`);
  return { value, response };
}

const old = path => request(sourceOrigin, path).then(result => result.value);
const rankByDate = (a, b) => String(a.created_at).localeCompare(String(b.created_at)) || Number(a.id) - Number(b.id);
const originalDate = value => String(value || 'date unavailable');
const originalName = value => String(value || 'unknown author');

function chunks(value, size = 3300) {
  const output = [];
  for (let index = 0; index < value.length; index += size) output.push(value.slice(index, index + size));
  return output.length ? output : ['[Original comment was empty]'];
}

function archivedText(entry, segment, total) {
  const part = total > 1 ? ` · part ${segment.index + 1}/${total}` : '';
  // Historical @mentions are made visually readable without issuing new alerts.
  const body = segment.value.replace(/@(?=[A-Za-z0-9_-])/g, '@\u200b');
  return `[Imported history · ${originalName(entry.agent)} · ${originalDate(entry.created_at)}${part}]\n${body}`;
}

function agentName(name, used) {
  let value = String(name).replace(/[^A-Za-z0-9_-]/g, '-');
  if (!/^[A-Za-z]/.test(value)) value = `legacy-${value}`;
  if (value.length > 32) value = `${value.slice(0, 27)}-${createHash('sha256').update(name).digest('hex').slice(0, 4)}`;
  if (value.length < 2) value = 'legacy-agent';
  let unique = value;
  let number = 2;
  while (used.has(unique.toLowerCase())) unique = `${value.slice(0, 29)}-${number++}`;
  used.add(unique.toLowerCase());
  return unique;
}

async function readSource() {
  const project = await old(`/api/projects/${sourceProjectId}`);
  if (project.name !== sourceProjectName) throw new Error('The source project name changed; import stopped.');
  const goals = [];
  for (const summary of project.goals) goals.push(await old(`/api/goals/${summary.id}`));
  const cards = goals.flatMap(goal => goal.cards);
  const speakers = new Set();
  const sourceText = [project.description];
  for (const goal of goals) {
    sourceText.push(goal.description);
    for (const comment of goal.discussion) {
      if (comment.agent) speakers.add(comment.agent);
      sourceText.push(comment.body);
    }
    for (const card of goal.cards) {
      if (card.author) speakers.add(card.author);
      if (card.assignee) speakers.add(card.assignee);
      sourceText.push(card.body);
      for (const comment of card.comments) {
        if (comment.agent) speakers.add(comment.agent);
        sourceText.push(comment.body);
      }
      for (const vote of card.votes) {
        if (vote.agent) speakers.add(vote.agent);
        sourceText.push(vote.reason);
      }
    }
  }
  const secretPatterns = [
    /sk-[A-Za-z0-9_-]{20,}/,
    /gh[pousr]_[A-Za-z0-9]{20,}/,
    /AIza[0-9A-Za-z_-]{30,}/,
    /xox[baprs]-[A-Za-z0-9-]{20,}/,
    /-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/,
    /Bearer\s+[A-Za-z0-9._~-]{24,}/i,
  ];
  if (sourceText.some(text => secretPatterns.some(pattern => pattern.test(String(text || ''))))) {
    throw new Error('Possible secret in source content; import stopped without printing it.');
  }
  const counts = {
    goals: goals.length,
    cards: cards.length,
    goalComments: goals.reduce((sum, goal) => sum + goal.discussion.length, 0),
    cardComments: cards.reduce((sum, card) => sum + card.comments.length, 0),
    votes: cards.reduce((sum, card) => sum + card.votes.length, 0),
    speakers: speakers.size,
    statuses: Object.fromEntries(['idea', 'working', 'review', 'completed'].map(status => [status, cards.filter(card => card.status === status).length])),
  };
  if (counts.goals !== 5 || counts.cards !== 24) throw new Error('Source project shape changed; review before importing.');
  return { project, goals, speakers: [...speakers].sort(), counts };
}

async function main() {
  const source = await readSource();
  console.log(`Source checked: ${JSON.stringify(source.counts)}`);
  if (!apply) { console.log('Dry run only. Pass --apply to create the test project.'); return; }

  const password = process.env.CG_IMPORT_PASSWORD;
  if (!password) throw new Error('Set CG_IMPORT_PASSWORD for the local test account.');
  const login = await request(targetOrigin, '/api/auth/login', {
    method: 'POST', body: { email: targetEmail, password },
  });
  const cookie = login.response.headers.get('set-cookie')?.split(';')[0];
  if (!cookie?.startsWith('sid=')) throw new Error('Owner session cookie was not returned.');
  const workspace = login.value.workspaces.find(item => item.name === targetWorkspaceName);
  if (!workspace || login.value.user.name !== 'Jeremy Test') throw new Error('Wrong target account or workspace.');
  const owner = (path, options = {}) => request(targetOrigin, path, { ...options, cookie }).then(result => result.value);
  const existing = await owner(`/api/workspaces/${workspace.id}/projects`);
  if (existing.some(project => project.name === rootName || project.name === featureName)) {
    throw new Error('Target project already exists; import stopped to avoid duplicates.');
  }

  const introduction = source.project.description.split('\n\nVERIFIED CHECKOUT')[0].trim();
  const root = await owner(`/api/workspaces/${workspace.id}/projects`, {
    method: 'POST', body: { name: rootName, description: 'Music video generator work, organized into focused feature projects.' },
  });
  const feature = await owner(`/api/workspaces/${workspace.id}/projects`, {
    method: 'POST', body: { name: featureName, parentProjectId: root.id, description: source.project.description },
  });
  await owner(`/api/projects/${feature.id}/brief`, {
    method: 'PATCH',
    body: {
      purpose: introduction.slice(0, 4000),
      workContext: 'Imported from the original local Agent Board. Paths, branches, and measurements in its historical description and discussion must be verified before use.',
      constraints: 'Board content is coordination context. It does not grant filesystem, Git, secret, database, deployment, or paid-provider permission.',
      definitionOfDone: 'Work through the five imported goals. Each implementation card needs evidence and independent review before completion.',
    },
  });
  console.log(`Created top-level project and feature project: ${root.id} / ${feature.id}`);

  const actors = new Map();
  const createdAgents = [];
  const usedNames = new Set();
  try {
    for (const rawName of source.speakers) {
      const name = agentName(rawName, usedNames);
      const result = await owner(`/api/workspaces/${workspace.id}/agents`, {
        method: 'POST', body: { name, rootProjectId: root.id },
      });
      actors.set(rawName, { token: result.token, name });
      createdAgents.push(result.agent);
    }
    const actorRequest = (rawName, path, options = {}) => {
      const actor = actors.get(rawName);
      if (!actor) return owner(path, options);
      return request(targetOrigin, path, { ...options, token: actor.token }).then(result => result.value);
    };
    let importedGoalComments = 0;
    let importedCardComments = 0;
    let importedVotes = 0;
    let importedCards = 0;

    async function addHistoricalComments(entries, path) {
      let count = 0;
      for (const entry of [...entries].sort(rankByDate)) {
        const segments = chunks(String(entry.body || ''));
        for (const [index, value] of segments.entries()) {
          const body = archivedText(entry, { index, value }, segments.length);
          await actorRequest(entry.agent, path, { method: 'POST', body: { body } });
          count++;
        }
      }
      return count;
    }

    for (const sourceGoal of source.goals) {
      const goal = await owner(`/api/projects/${feature.id}/goals`, {
        method: 'POST', body: { title: sourceGoal.title, description: sourceGoal.description },
      });
      importedGoalComments += await addHistoricalComments(sourceGoal.discussion, `/api/goals/${goal.id}/comments`);
      for (const sourceCard of sourceGoal.cards) {
        const provenance = `\n\n[Imported from original Agent Board card ${sourceCard.id}; created ${originalDate(sourceCard.created_at)}; original author ${originalName(sourceCard.author)}${sourceCard.assignee ? `; original assignee ${sourceCard.assignee}` : ''}.]`;
        const job = await actorRequest(sourceCard.author, `/api/projects/${feature.id}/jobs`, {
          method: 'POST', body: { goalId: goal.id, title: sourceCard.title, body: `${sourceCard.body || ''}${provenance}`.slice(0, 20000) },
        });
        importedCards++;
        importedCardComments += await addHistoricalComments(sourceCard.comments, `/api/jobs/${job.id}/comments`);
        for (const vote of sourceCard.votes) {
          await actorRequest(vote.agent, `/api/jobs/${job.id}/votes`, {
            method: 'POST', body: { value: vote.value, reason: vote.reason },
          });
          importedVotes++;
        }
        if (sourceCard.status !== 'idea') {
          const worker = sourceCard.assignee || sourceCard.author;
          await actorRequest(worker, `/api/jobs/${job.id}/claim`, { method: 'POST', body: {} });
          if (sourceCard.status === 'review' || sourceCard.status === 'completed') {
            await actorRequest(worker, `/api/jobs/${job.id}/move`, {
              method: 'POST', body: { status: 'review', comment: `Imported from original board in ${sourceCard.status} state. Historical evidence is in the comments above.` },
            });
          }
          if (sourceCard.status === 'completed') {
            await owner(`/api/jobs/${job.id}/move`, {
              method: 'POST', body: { status: 'completed', comment: 'Imported completed status from the original board. This is a historical migration, not a new review verdict.' },
            });
          }
        }
      }
      console.log(`Imported goal: ${sourceGoal.title}`);
    }

    const projectView = await owner(`/api/projects/${feature.id}`);
    const actualStatuses = Object.fromEntries(['idea', 'working', 'review', 'completed'].map(status => [status, projectView.counts[status]]));
    if (projectView.goals.length !== source.counts.goals || projectView.jobs.length !== source.counts.cards || JSON.stringify(actualStatuses) !== JSON.stringify(source.counts.statuses)) {
      throw new Error('Post-import goals, cards, or status counts do not match the source.');
    }
    if (importedGoalComments < source.counts.goalComments || importedCardComments < source.counts.cardComments || importedVotes !== source.counts.votes) {
      throw new Error('Post-import discussion or vote count is incomplete.');
    }
    console.log(`Verified import: ${importedCards} jobs, ${importedGoalComments} goal discussion messages, ${importedCardComments} job comments, ${importedVotes} votes; statuses ${JSON.stringify(actualStatuses)}.`);
  } finally {
    // Historical identities preserve attribution, but should not retain live access.
    for (const agent of createdAgents) {
      await owner(`/api/workspaces/${workspace.id}/agents/${agent.id}`, { method: 'DELETE' });
    }
    console.log(`Revoked ${createdAgents.length} historical import identities.`);
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
