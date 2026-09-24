import { FolderOpen, Link2 } from 'lucide-react';
import type { JobWorkLocation } from './types';

export function JobWorkLocations({ locations }: { locations: JobWorkLocation[] }) {
  return <section className="drawer-section job-work-locations">
    <div className="section-title"><h3>Project work locations</h3><span>{locations.length}</span></div>
    <p className="section-subtitle">Current project directions. Your agent app controls access to folders and links.</p>
    {locations.length ? <div className="work-locations-list">{locations.map(location =>
      <div className="work-location" key={location.id}>
        <span className="work-location-icon">{location.kind === 'folder' ? <FolderOpen size={17} /> : <Link2 size={17} />}</span>
        <div><strong>{location.label}{location.inherited && <small> · from {location.sourceProjectName}</small>}</strong>
          {location.kind === 'link' ? <a href={location.target} target="_blank" rel="noopener noreferrer">{location.target}</a> : <code>{location.target}</code>}
        </div>
      </div>)}</div> : <p className="work-locations-empty">No work locations saved for this project.</p>}
  </section>;
}
