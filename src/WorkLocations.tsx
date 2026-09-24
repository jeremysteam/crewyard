import { useState, type FormEvent } from 'react';
import { FolderOpen, Link2, Plus, X } from 'lucide-react';
import { api, post } from './api';
import type { Project, WorkLocation } from './types';

export function WorkLocations({ project, parent, canEdit, onChange, notify }: {
  project: Project;
  parent: Project | null;
  canEdit: boolean;
  onChange: () => Promise<void>;
  notify: (message: string) => void;
}) {
  const [adding, setAdding] = useState(false);
  const [label, setLabel] = useState('');
  const [kind, setKind] = useState<WorkLocation['kind']>('folder');
  const [target, setTarget] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const entries = [
    ...(parent?.workLocations || []).map(location => ({ location, inherited: true })),
    ...project.workLocations.map(location => ({ location, inherited: false })),
  ];

  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true); setError('');
    try {
      await post(`/projects/${project.id}/work-locations`, { label, kind, target });
      await onChange();
      setLabel(''); setTarget(''); setAdding(false);
      notify('Work location saved');
    } catch (cause) { setError((cause as Error).message); }
    finally { setBusy(false); }
  }

  async function remove(location: WorkLocation) {
    setError('');
    try {
      await api(`/projects/${project.id}/work-locations/${location.id}`, { method: 'DELETE' });
      await onChange();
      notify('Work location removed');
    } catch (cause) { setError((cause as Error).message); }
  }

  return <section className="work-locations">
    <div className="work-locations-heading"><div><span className="eyebrow">WHERE TO LOOK</span><h2>Work locations</h2><p>Save pointers for agents working on this project. A path or link does not give anyone access.</p></div>{canEdit && <button className="button button-subtle" onClick={() => { setAdding(value => !value); setError(''); }}><Plus size={15} /> Add location</button>}</div>
    {entries.length ? <div className="work-locations-list">{entries.map(({ location, inherited }) => <div className="work-location" key={location.id}><span className="work-location-icon">{location.kind === 'folder' ? <FolderOpen size={17} /> : <Link2 size={17} />}</span><div><strong>{location.label}{inherited && <small> · from {parent?.name}</small>}</strong>{location.kind === 'link' ? <a href={location.target} target="_blank" rel="noopener noreferrer">{location.target}</a> : <code>{location.target}</code>}</div>{canEdit && !inherited && <button className="work-location-remove" title={`Remove ${location.label}`} aria-label={`Remove ${location.label}`} onClick={() => void remove(location)}><X size={15} /></button>}</div>)}</div> : <p className="work-locations-empty">No locations added. You can label a local folder, Git repository, or document link.</p>}
    {adding && <form className="work-location-form" onSubmit={event => void save(event)}><label>Label<input value={label} onChange={event => setLabel(event.target.value)} placeholder="Main repo or project documents" maxLength={80} required /></label><label>Type<select value={kind} onChange={event => { setKind(event.target.value as WorkLocation['kind']); setTarget(''); }}><option value="folder">Local folder path</option><option value="link">HTTPS link, including Git</option></select></label><label className="work-location-target">{kind === 'folder' ? 'Folder path' : 'Link'}<input value={target} onChange={event => setTarget(event.target.value)} placeholder={kind === 'folder' ? 'C:\\work\\my-project' : 'https://github.com/owner/repo'} maxLength={2048} required /></label><p>Save a location hint only. Agents still need their own permission to open it. Do not put passwords or tokens here.</p>{error && <div className="form-error">{error}</div>}<div className="work-location-actions"><button type="button" className="button button-subtle" onClick={() => setAdding(false)}>Cancel</button><button className="button button-primary" disabled={busy}>Save location</button></div></form>}
  </section>;
}
