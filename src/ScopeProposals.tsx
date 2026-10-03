import { useCallback, useEffect, useState } from 'react';
import { api, post } from './api';
import { Avatar } from './Avatar';
import type { Project, ProjectBrief, ScopeProposal } from './types';

const fields: { key: keyof ProjectBrief; label: string }[] = [
  { key: 'purpose', label: 'Purpose / goal' },
  { key: 'workContext', label: 'Work context' },
  { key: 'constraints', label: 'Constraints' },
  { key: 'definitionOfDone', label: 'Definition of done' },
];

function Draft({ proposal, project, onChange }: { proposal: ScopeProposal; project: Project; onChange: () => Promise<void> }) {
  const [brief, setBrief] = useState<ProjectBrief>(proposal.brief);
  const [plan, setPlan] = useState(proposal.plan);
  const [reason, setReason] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  async function decide(decision: 'approve' | 'reject') {
    if (decision === 'reject' && !reason.trim()) { setError('Add a reason before sending the draft back.'); return; }
    setBusy(true); setError('');
    try {
      await post(`/projects/${project.id}/scope-proposals/${proposal.id}/decision`, {
        decision, reason: reason.trim(), ...(decision === 'approve' ? { brief, plan } : {}),
      });
      await onChange();
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }
  return <article className="scope-proposal-card">
    <div className="scope-proposal-meta"><strong className="author-with-avatar"><Avatar id={proposal.submittedBy.id} name={proposal.submittedBy.name} bot={proposal.submittedBy.type === 'agent'} size="small" />Draft from {proposal.submittedBy.name}</strong><span>{new Date(proposal.createdAt).toLocaleDateString()}</span></div>
    <p>Review and edit before applying. Applying updates the project brief and scope plan only; it does not create jobs, invite agents, or change work locations.</p>
    <div className="scope-proposal-fields">{fields.map(field => <label key={field.key}>{field.label}<textarea value={brief[field.key]} maxLength={4000} rows={3} onChange={e => setBrief(current => ({ ...current, [field.key]: e.target.value }))} /></label>)}
      <label>Feature and goal plan<textarea value={plan} maxLength={8000} rows={5} onChange={e => setPlan(e.target.value)} /></label>
      <label>Decision note <span className="optional">required to reject</span><textarea value={reason} maxLength={2000} rows={2} onChange={e => setReason(e.target.value)} placeholder="Explain what to change, or note why you approved this draft" /></label>
    </div>
    {error && <div className="form-error">{error}</div>}
    <div className="scope-proposal-actions"><button type="button" className="button button-subtle" disabled={busy} onClick={() => void decide('reject')}>Send back</button><button type="button" className="button button-primary" disabled={busy} onClick={() => void decide('approve')}>{busy ? 'Saving…' : 'Apply scope'}</button></div>
  </article>;
}

export function ScopeProposals({ project, onChange }: { project: Project; onChange: () => Promise<void> }) {
  const [proposals, setProposals] = useState<ScopeProposal[]>([]);
  const [error, setError] = useState('');
  const load = useCallback(async () => {
    try { setProposals(await api<ScopeProposal[]>(`/projects/${project.id}/scope-proposals`)); setError(''); }
    catch (cause) { setError((cause as Error).message); }
  }, [project.id]);
  useEffect(() => { void load(); const timer = window.setInterval(() => void load(), 15_000); return () => window.clearInterval(timer); }, [load]);
  async function changed() { await onChange(); await load(); }
  return <section className="project-brief scope-proposals"><div className="project-brief-heading"><div><span className="eyebrow">AGENT DRAFTS</span><h2>Scope proposals</h2><p>Ask an agent on this project to draft its brief and feature plan. You decide what becomes official.</p></div></div>
    {error && <div className="form-error">{error}</div>}
    {proposals.filter(proposal => proposal.status === 'pending').map(proposal => <Draft key={proposal.id} proposal={proposal} project={project} onChange={changed} />)}
    {!proposals.some(proposal => proposal.status === 'pending') && <p className="scope-proposal-empty">No draft is waiting for your review.</p>}
    {proposals.some(proposal => proposal.status !== 'pending') && <details className="scope-proposal-history"><summary>Past decisions ({proposals.filter(proposal => proposal.status !== 'pending').length})</summary>{proposals.filter(proposal => proposal.status !== 'pending').map(proposal => <details key={proposal.id} className="scope-history-row"><summary>{proposal.status === 'approved' ? 'Applied' : 'Sent back'} · {proposal.submittedBy.name} · {new Date(proposal.decidedAt || proposal.createdAt).toLocaleDateString()}</summary>{proposal.decisionNote && <p>{proposal.decisionNote}</p>}<strong>Original draft</strong>{fields.map(field => <p key={field.key}><b>{field.label}:</b> {proposal.brief[field.key]}</p>)}<p><b>Plan:</b> {proposal.plan}</p>{proposal.appliedBrief && <><strong>Applied version</strong>{fields.map(field => <p key={field.key}><b>{field.label}:</b> {proposal.appliedBrief?.[field.key]}</p>)}<p><b>Plan:</b> {proposal.appliedPlan}</p></>}</details>)}</details>}
  </section>;
}
