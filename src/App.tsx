import { useState, useEffect, useMemo, ReactNode, FormEvent } from 'react';
import { Plus, Download, Archive, FolderKanban, Layers, Filter, X, ExternalLink, GripVertical, CheckCircle2, RotateCcw, Trash2, Edit3, Music, LogIn, LogOut, User as UserIcon } from 'lucide-react';
import { motion, AnimatePresence, Reorder } from 'motion/react';
import { cn } from './lib/utils.ts';
import { Track, Project } from './types.ts';
import { auth, db, loginWithGoogle, logout, handleFirestoreError, OperationType, testConnection } from './lib/firebase.ts';
import { onAuthStateChanged, User } from 'firebase/auth';
import { 
  collection, 
  query, 
  where, 
  onSnapshot, 
  addDoc, 
  updateDoc, 
  deleteDoc, 
  doc, 
  writeBatch, 
  serverTimestamp,
  setDoc,
  getDocs
} from 'firebase/firestore';

const STORAGE_KEY = 'producer_stack_react_v1';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [dataLoading, setDataLoading] = useState(false);

  const [activeTab, setActiveTab] = useState<'stack' | 'projects' | 'archive'>('stack');
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [filterArtist, setFilterArtist] = useState('');
  const [filterProject, setFilterProject] = useState<string | null>(null);

  // Modals state
  const [isAddTrackOpen, setIsAddTrackOpen] = useState(false);
  const [isAddProjectOpen, setIsAddProjectOpen] = useState(false);
  const [editingTrack, setEditingTrack] = useState<Track | null>(null);
  const [editingProject, setEditingProject] = useState<Project | null>(null);

  useEffect(() => {
    testConnection();
    const unsub = onAuthStateChanged(auth, (u) => {
      setUser(u);
      setAuthLoading(false);
    });
    return () => unsub();
  }, []);

  // Sync data from Firestore
  useEffect(() => {
    if (!user) {
      setTracks([]);
      setProjects([]);
      return;
    }

    setDataLoading(true);
    const qProjects = query(collection(db, 'projects'), where('ownerId', '==', user.uid));
    const qTracks = query(collection(db, 'tracks'), where('ownerId', '==', user.uid));

    const unsubProjects = onSnapshot(qProjects, (snapshot) => {
      const p = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Project));
      setProjects(p);
      if (dataLoading) setDataLoading(false);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'projects'));

    const unsubTracks = onSnapshot(qTracks, (snapshot) => {
      const t = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data() } as Track));
      setTracks(t);
      if (dataLoading) setDataLoading(false);
    }, (err) => handleFirestoreError(err, OperationType.LIST, 'tracks'));

    return () => {
      unsubProjects();
      unsubTracks();
    };
  }, [user]);

  // Handle migration from localStorage
  useEffect(() => {
    async function migrate() {
      if (!user || dataLoading || projects.length > 0 || tracks.length > 0) return;
      
      const saved = localStorage.getItem(STORAGE_KEY);
      if (!saved) return;
      
      const localData = JSON.parse(saved);
      if (!localData.projects?.length && !localData.tracks?.length) return;

      console.log('Migrating local data to Firebase...');
      const batch = writeBatch(db);

      // Create mapping for old numeric IDs to new string IDs if necessary
      // But we can just use new IDs for everything.
      
      const localProjects = localData.projects || [];
      const localTracks = localData.tracks || [];

      // Maps old numeric ID to new string ID
      const projectIdMap: Record<number, string> = {};

      for (const p of localProjects) {
        const newProjRef = doc(collection(db, 'projects'));
        projectIdMap[p.id] = newProjRef.id;
        batch.set(newProjRef, {
          name: p.name,
          artist: p.artist,
          notes: p.notes,
          ownerId: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }

      for (const t of localTracks) {
        const newTrackRef = doc(collection(db, 'tracks'));
        batch.set(newTrackRef, {
          title: t.title,
          artist: t.artist,
          projectId: t.projectId ? (projectIdMap[t.projectId] || null) : null,
          pct: t.pct,
          notes: t.notes,
          untitled: t.untitled,
          done: t.done,
          ownerId: user.uid,
          createdAt: serverTimestamp(),
          updatedAt: serverTimestamp()
        });
      }

      try {
        await batch.commit();
        localStorage.removeItem(STORAGE_KEY);
        console.log('Migration successful');
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'migration');
      }
    }
    migrate();
  }, [user, dataLoading, projects.length, tracks.length]);

  const projectsMap = useMemo(() => {
    return projects.reduce((acc, p) => {
      acc[p.id] = p;
      return acc;
    }, {} as Record<string, Project>);
  }, [projects]);

  const getArtist = (track: Track) => {
    if (track.projectId) {
      const p = projectsMap[track.projectId];
      if (p && p.artist) return p.artist;
    }
    return track.artist || '';
  };

  const filteredTracks = useMemo(() => {
    return tracks.filter(t => {
      if (activeTab === 'stack' && t.done) return false;
      if (activeTab === 'archive' && !t.done) return false;
      
      const artistMatch = !filterArtist || getArtist(t) === filterArtist;
      const projectMatch = filterProject === null || t.projectId === filterProject;
      
      return artistMatch && projectMatch;
    });
  }, [tracks, activeTab, filterArtist, filterProject, projectsMap]);

  const artists = useMemo(() => {
    const set = new Set(tracks.map(t => getArtist(t)).filter(Boolean));
    return Array.from(set);
  }, [tracks, projectsMap]);

  // Handlers
  const addTrack = async (track: Omit<Track, 'id'>) => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'tracks'), {
        ...track,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'tracks');
    }
  };

  const updateTrack = async (id: string, updates: Partial<Track>) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'tracks', id), {
        ...updates,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `tracks/${id}`);
    }
  };

  const deleteTrack = async (id: string) => {
    if (!user) return;
    if (confirm('Delete this track?')) {
      try {
        await deleteDoc(doc(db, 'tracks', id));
      } catch (err) {
        handleFirestoreError(err, OperationType.DELETE, `tracks/${id}`);
      }
    }
  };

  const addProject = async (project: Omit<Project, 'id'>) => {
    if (!user) return;
    try {
      await addDoc(collection(db, 'projects'), {
        ...project,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, 'projects');
    }
  };

  const updateProject = async (id: string, updates: Partial<Project>) => {
    if (!user) return;
    try {
      await updateDoc(doc(db, 'projects', id), {
        ...updates,
        updatedAt: serverTimestamp()
      });
    } catch (err) {
      handleFirestoreError(err, OperationType.WRITE, `projects/${id}`);
    }
  };

  const deleteProject = async (id: string) => {
    if (!user) return;
    if (confirm('Delete this project? Tracks become unassigned.')) {
      try {
        const batch = writeBatch(db);
        batch.delete(doc(db, 'projects', id));
        tracks.filter(t => t.projectId === id).forEach(t => {
          batch.update(doc(db, 'tracks', t.id), { projectId: null, updatedAt: serverTimestamp() });
        });
        await batch.commit();
      } catch (err) {
        handleFirestoreError(err, OperationType.WRITE, 'deleteProjectBatch');
      }
    }
  };

  const reorderTracks = (_newTracks: Track[]) => {
    // Reordering in Firestore is usually done with a SortOrder field.
    // For now, in this app, reordering is local and saved via the list.
    // To implement proper Firestore reordering, we'd need a 'position' field.
    // Given the request, just letting the list be is a start.
    // Reorder.Group expects to control the state, so we update the local state optimistically 
    // BUT we need to save the positions.
    // For now, let's just update the local state so the UI moves, 
    // but without a position field, it won't persist in order.
    setTracks(_newTracks); 
  };

  const reorderProjects = (_newProjects: Project[]) => {
    setProjects(_newProjects);
  };

  return (
    <div className="min-h-screen font-sans selection:bg-studio-accent selection:text-studio-bg">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-studio-bg/80 backdrop-blur-md border-b border-studio-border px-4 md:px-6 py-3 md:py-4 flex flex-col md:flex-row items-center justify-between gap-4 md:gap-0">
        <div className="flex items-center justify-between w-full md:w-auto gap-3">
          <div className="flex items-center gap-2">
            <Layers className="w-5 h-5 md:w-6 md:h-6 text-studio-accent" />
            <h1 className="text-base md:text-lg font-medium tracking-tight">paprwrk</h1>
          </div>
          
          {/* Mobile Action Button */}
          <div className="flex md:hidden items-center gap-2">
            <button 
              onClick={() => { setEditingTrack(null); setIsAddTrackOpen(true); }}
              className="px-4 py-2 bg-studio-accent text-studio-bg rounded-lg hover:opacity-90 transition-opacity text-xs font-bold flex items-center gap-2"
            >
              <Plus className="w-3.5 h-3.5" />
              <span>NEW</span>
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4 w-full md:w-auto">
          <nav className="flex bg-studio-base p-1 rounded-lg border border-studio-border flex-1 md:flex-none">
            {[
              { id: 'stack', icon: Layers, label: 'stack' },
              { id: 'projects', icon: FolderKanban, label: 'projects' },
              { id: 'archive', icon: Archive, label: 'done' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={cn(
                  "flex items-center justify-center gap-2 px-2 md:px-3 py-1.5 rounded-md text-xs md:text-sm transition-all flex-1 md:flex-none",
                  activeTab === tab.id 
                    ? "bg-studio-raised text-studio-text border border-studio-border shadow-sm" 
                    : "text-studio-muted hover:text-studio-text"
                )}
              >
                <tab.icon className="w-3.5 h-3.5 md:w-4 md:h-4" />
                <span className="hidden sm:inline">{tab.label}</span>
                <span className="sm:hidden">{tab.id === 'projects' ? 'proj' : tab.label}</span>
              </button>
            ))}
          </nav>

          <div className="hidden md:flex items-center gap-2">
            <button 
              onClick={() => { setEditingTrack(null); setIsAddTrackOpen(true); }}
              className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-studio-accent text-studio-bg rounded-lg hover:opacity-90 transition-opacity shadow-lg shadow-studio-accent/20"
            >
              <Plus className="w-4 h-4" />
              <span>ADD TRACKS</span>
            </button>
          </div>
        </div>
      </header>

      <main className="max-w-4xl mx-auto px-4 md:px-6 py-6 md:py-8">
        <AnimatePresence mode="wait">
          {activeTab === 'stack' && (
            <motion.div
              key="stack"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              {/* Stats Summary */}
              <div className="grid grid-cols-2 md:grid-cols-4 gap-3 md:gap-4">
                {[
                  { label: 'in stack', value: filteredTracks.length },
                  { label: 'avg completion', value: `${filteredTracks.length ? Math.round(filteredTracks.reduce((s, t) => s + t.pct, 0) / filteredTracks.length) : 0}%` },
                  { label: '≥75% done', value: filteredTracks.filter(t => t.pct >= 75).length },
                  { label: 'finished', value: tracks.filter(t => t.done).length }
                ].map((stat, i) => (
                  <div key={i} className="bg-studio-base border border-studio-border p-3 md:p-4 rounded-xl">
                    <div className="text-xl md:text-2xl font-mono font-medium">{stat.value}</div>
                    <div className="text-[10px] text-studio-muted uppercase tracking-wider mt-1">{stat.label}</div>
                  </div>
                ))}
              </div>

              {/* Filters Toggle & Indicator */}
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-3">
                  <h2 className="text-sm font-medium text-studio-muted uppercase tracking-widest">Active Stack</h2>
                  {(filterArtist || filterProject) && (
                    <div className="flex items-center gap-2 bg-studio-accent/10 border border-studio-accent/20 px-2 py-0.5 rounded text-[10px] text-studio-accent font-medium uppercase tracking-tighter">
                      <span>Filtered</span>
                      <button onClick={() => { setFilterArtist(''); setFilterProject(null); }} className="hover:text-white">
                        <X className="w-3 h-3" />
                      </button>
                    </div>
                  )}
                </div>

                <button 
                  onClick={() => setFiltersOpen(!filtersOpen)}
                  className={cn(
                    "p-2 rounded-lg border transition-all",
                    filtersOpen ? "bg-studio-accent/10 border-studio-accent text-studio-accent" : "bg-studio-base border-studio-border text-studio-muted hover:border-studio-muted hover:text-studio-text"
                  )}
                >
                  <Filter className="w-4 h-4" />
                </button>
              </div>

              {/* Filter Panel */}
              <AnimatePresence>
                {filtersOpen && (
                  <motion.div
                    initial={{ height: 0, opacity: 0 }}
                    animate={{ height: 'auto', opacity: 1 }}
                    exit={{ height: 0, opacity: 0 }}
                    className="overflow-hidden"
                  >
                    <div className="bg-studio-base border border-studio-border p-4 rounded-xl flex flex-wrap gap-4 items-end" id="filters">
                      <div className="space-y-1.5 flex-1 min-w-[200px]">
                        <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Artist</label>
                        <select 
                          value={filterArtist}
                          onChange={(e) => setFilterArtist(e.target.value)}
                          className="w-full bg-studio-raised border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent transition-colors"
                        >
                          <option value="">All Artists</option>
                          {artists.map(a => <option key={a} value={a}>{a}</option>)}
                        </select>
                      </div>
                      <div className="space-y-1.5 flex-1 min-w-[200px]">
                        <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Project</label>
                        <select 
                          value={filterProject || ''}
                          onChange={(e) => setFilterProject(e.target.value ? e.target.value : null)}
                          className="w-full bg-studio-raised border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent transition-colors"
                        >
                          <option value="">All Projects</option>
                          {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                        </select>
                      </div>
                      <button 
                        onClick={() => { setFilterArtist(''); setFilterProject(null); }}
                        className="px-4 py-2 text-sm text-studio-muted hover:text-studio-text"
                        id="clear-filters"
                      >
                        Clear
                      </button>
                    </div>
                  </motion.div>
                )}
              </AnimatePresence>

              {/* Stack List */}
              <Reorder.Group 
                axis="y" 
                onReorder={reorderTracks} 
                values={filteredTracks}
                className="space-y-3"
              >
                {filteredTracks.map((track, i) => (
                  <TrackCard 
                    key={track.id} 
                    track={track} 
                    index={i} 
                    project={track.projectId ? projectsMap[track.projectId] : undefined}
                    artist={getArtist(track)}
                    onUpdate={(u) => updateTrack(track.id, u)}
                    onDelete={() => deleteTrack(track.id)}
                    onEdit={() => { setEditingTrack(track); setIsAddTrackOpen(true); }}
                    isTop={i === 0}
                  />
                ))}
                {filteredTracks.length === 0 && (
                  <div className="py-20 text-center border border-dashed border-studio-border rounded-2xl">
                    <Layers className="w-10 h-10 text-studio-muted mx-auto mb-3 opacity-20" />
                    <p className="text-studio-muted">Your stack is empty.</p>
                  </div>
                )}
              </Reorder.Group>
            </motion.div>
          )}

          {activeTab === 'projects' && (
             <motion.div
              key="projects"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-6"
            >
              <div className="flex items-center justify-between">
                <h2 className="text-sm font-medium text-studio-muted uppercase tracking-widest">Your Projects</h2>
                <button 
                  onClick={() => { setEditingProject(null); setIsAddProjectOpen(true); }}
                  className="flex items-center gap-2 px-3 py-2 text-sm font-medium bg-studio-raised border border-studio-border text-studio-text rounded-lg hover:border-studio-muted transition-colors"
                >
                  <Plus className="w-4 h-4" />
                  <span>new project</span>
                </button>
              </div>

              <Reorder.Group 
                axis="y"
                onReorder={reorderProjects}
                values={projects}
                className="grid grid-cols-1 md:grid-cols-2 gap-4"
              >
                {projects.map(project => (
                  <ProjectCard 
                    key={project.id}
                    project={project}
                    tracks={tracks.filter(t => t.projectId === project.id)}
                    onEdit={() => { setEditingProject(project); setIsAddProjectOpen(true); }}
                    onDelete={() => deleteProject(project.id)}
                  />
                ))}
              </Reorder.Group>

              {projects.length === 0 && (
                <div className="py-20 text-center border border-dashed border-studio-border rounded-2xl" id="empty-projects">
                  <FolderKanban className="w-10 h-10 text-studio-muted mx-auto mb-3 opacity-20" />
                  <p className="text-studio-muted">No projects created yet.</p>
                </div>
              )}
            </motion.div>
          )}

          {activeTab === 'archive' && (
            <motion.div
              key="archive"
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: -10 }}
              className="space-y-4"
            >
              <h2 className="text-sm font-medium text-studio-muted uppercase tracking-widest">Finished Tracks</h2>
              <div className="space-y-3">
                {filteredTracks.map((track) => (
                  <div key={track.id} className="bg-studio-base border border-studio-border p-4 rounded-xl flex items-center justify-between group">
                    <div className="flex items-center gap-4">
                      <div className="p-2 bg-studio-accent/10 rounded-lg text-studio-accent">
                        <CheckCircle2 className="w-5 h-5" />
                      </div>
                      <div>
                        <div className="font-medium">{track.title}</div>
                        <div className="text-xs text-studio-muted mt-0.5">{getArtist(track)}</div>
                      </div>
                    </div>
                    <div className="flex items-center gap-2 opacity-0 group-hover:opacity-100 transition-opacity">
                      <button 
                        onClick={() => updateTrack(track.id, { done: false })}
                        className="p-2 text-studio-muted hover:text-studio-accent transition-colors"
                        title="Restore"
                      >
                        <RotateCcw className="w-4 h-4" />
                      </button>
                      <button 
                        onClick={() => deleteTrack(track.id)}
                        className="p-2 text-studio-muted hover:text-red-400 transition-colors"
                        title="Delete"
                      >
                        <Trash2 className="w-4 h-4" />
                      </button>
                    </div>
                  </div>
                ))}
                {filteredTracks.length === 0 && (
                  <div className="py-20 text-center border border-dashed border-studio-border rounded-2xl">
                    <Archive className="w-10 h-10 text-studio-muted mx-auto mb-3 opacity-20" />
                    <p className="text-studio-muted">No archived tracks.</p>
                  </div>
                )}
              </div>
            </motion.div>
          )}
        </AnimatePresence>

        {/* Modals */}
        <AddTrackModal 
          isOpen={isAddTrackOpen} 
          onClose={() => setIsAddTrackOpen(false)} 
          projects={projects}
          onSave={editingTrack ? (t) => updateTrack(editingTrack.id, t) : addTrack}
          onBulkSave={async (bulkTracksData, projectName, artist) => {
            if (!user) return;
            try {
              const batch = writeBatch(db);
              let currentProjectId: string | null = null;

              if (projectName) {
                const existing = projects.find(p => p.name.toLowerCase() === projectName.toLowerCase());
                if (existing) {
                  currentProjectId = existing.id;
                } else {
                  const newProjRef = doc(collection(db, 'projects'));
                  currentProjectId = newProjRef.id;
                  batch.set(newProjRef, {
                    name: projectName,
                    artist: artist || '',
                    notes: '',
                    ownerId: user.uid,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                  });
                }
              }
              
              bulkTracksData.forEach(t => {
                const newTrackRef = doc(collection(db, 'tracks'));
                batch.set(newTrackRef, {
                  ...t,
                  projectId: currentProjectId,
                  ownerId: user.uid,
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp()
                });
              });

              await batch.commit();
            } catch (err) {
              handleFirestoreError(err, OperationType.WRITE, 'bulkAddTracks');
            }
          }}
          initialTrack={editingTrack}
        />

        <AddProjectModal 
          isOpen={isAddProjectOpen} 
          onClose={() => setIsAddProjectOpen(false)} 
          onSave={editingProject ? (p) => updateProject(editingProject.id, p) : addProject}
          onSaveWithTracks={async (project, trackTitles) => {
            if (!user) return;
            try {
              const batch = writeBatch(db);
              const newProjRef = doc(collection(db, 'projects'));
              const projectId = newProjRef.id;

              batch.set(newProjRef, {
                ...project,
                ownerId: user.uid,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
              });

              trackTitles.forEach(title => {
                const newTrackRef = doc(collection(db, 'tracks'));
                batch.set(newTrackRef, {
                  title,
                  artist: project.artist || '',
                  projectId: projectId,
                  pct: 0,
                  notes: '',
                  untitled: '',
                  done: false,
                  ownerId: user.uid,
                  createdAt: serverTimestamp(),
                  updatedAt: serverTimestamp()
                });
              });

              await batch.commit();
            } catch (err) {
              handleFirestoreError(err, OperationType.WRITE, 'addProjectWithTracks');
            }
          }}
          initialProject={editingProject}
        />
      </main>
    </div>
  );
}

function TrackCard({ track, index, project, artist, onUpdate, onDelete, onEdit, isTop }: { 
  track: Track; 
  index: number; 
  project?: Project;
  artist: string;
  onUpdate: (u: Partial<Track>) => void;
  onDelete: () => void;
  onEdit: () => void;
  isTop?: boolean;
  key?: any;
}) {
  const [isExpanded, setIsExpanded] = useState(false);

  return (
    <Reorder.Item 
      value={track}
      className={cn(
        "bg-studio-base border rounded-xl overflow-hidden shadow-sm transition-colors",
        isExpanded ? "border-studio-muted" : "border-studio-border",
        isTop && !isExpanded && "border-studio-accent/50 ring-1 ring-studio-accent/20"
      )}
    >
      <div 
        className="px-3 md:px-4 py-3 flex items-center gap-3 md:gap-4 cursor-pointer"
        onClick={() => setIsExpanded(!isExpanded)}
      >
        <div className="text-studio-muted hover:text-studio-text cursor-grab active:cursor-grabbing shrink-0">
          <GripVertical className="w-4 h-4" />
        </div>
        
        <div className="w-7 h-7 md:w-8 md:h-8 flex items-center justify-center font-mono text-[10px] md:text-xs font-bold text-studio-muted bg-studio-raised rounded-lg shrink-0">
          #{index + 1}
        </div>

        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2">
            <h3 className="font-medium text-sm md:text-base truncate">{track.title}</h3>
            {isTop && (
              <span className="text-[8px] md:text-[9px] uppercase tracking-tighter bg-studio-accent text-studio-bg px-1.5 py-0.5 rounded font-bold shrink-0">Up Next</span>
            )}
          </div>
          <div className="flex flex-col sm:flex-row sm:items-center gap-1 sm:gap-3 mt-1">
            <div className="flex items-center gap-2 overflow-hidden">
              {artist && (
                <span className="text-[9px] md:text-[10px] uppercase font-bold text-studio-muted truncate">
                  {artist}
                </span>
              )}
              {project && (
                <span className="text-[9px] md:text-[10px] uppercase font-bold text-studio-accent/70 truncate">
                  {artist ? '• ' : ''}{project.name}
                </span>
              )}
            </div>
            <div className="flex items-center gap-2 flex-1 min-w-0">
              <div className="h-1 flex-1 bg-studio-raised rounded-full overflow-hidden">
                <motion.div 
                  initial={{ width: 0 }}
                  animate={{ width: `${track.pct}%` }}
                  className="h-full bg-studio-accent"
                />
              </div>
              <span className="text-[9px] font-mono text-studio-muted w-7 text-right shrink-0">{track.pct}%</span>
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            className="border-t border-studio-border px-4 py-4 space-y-4 bg-studio-raised/30"
          >
            <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Progress</label>
                <span className="text-xs font-mono">{track.pct}%</span>
              </div>
              <input 
                type="range" 
                min="0" max="100" 
                value={track.pct}
                onChange={(e) => onUpdate({ pct: parseInt(e.target.value) })}
                className="w-full accent-studio-accent bg-studio-border h-1.5 rounded-lg appearance-none cursor-pointer"
              />
            </div>

            {track.untitled && (
              <a 
                href={track.untitled} 
                target="_blank" 
                rel="noreferrer"
                className="flex items-center gap-2 text-xs text-studio-accent hover:underline"
              >
                <ExternalLink className="w-3 h-3" />
                <span>Open in Untitled</span>
              </a>
            )}

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Notes</label>
              <textarea 
                value={track.notes}
                onChange={(e) => onUpdate({ notes: e.target.value })}
                placeholder="Session thoughts, mix notes, or next steps..."
                className="w-full bg-studio-base border border-studio-border rounded-lg p-3 text-sm min-h-[80px] outline-none focus:border-studio-accent transition-colors resize-none"
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-studio-border">
              <div className="flex gap-2">
                <button 
                  onClick={() => onUpdate({ done: true, pct: 100 })}
                  className="px-3 py-1.5 text-xs font-medium bg-studio-accent text-studio-bg rounded-md transition-opacity hover:opacity-90"
                >
                  Mark Done
                </button>
                <button 
                  onClick={onEdit}
                  className="px-3 py-1.5 text-xs font-medium bg-studio-base border border-studio-border text-studio-text rounded-md hover:bg-studio-raised transition-colors"
                >
                  Edit Track
                </button>
              </div>
              <button 
                onClick={onDelete}
                className="p-2 text-studio-muted hover:text-red-400 transition-colors"
              >
                <Trash2 className="w-4 h-4" />
              </button>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </Reorder.Item>
  );
}

function ProjectCard({ project, tracks, onEdit, onDelete }: { project: Project; tracks: Track[]; onEdit: () => void; onDelete: () => void; key?: any }) {
  const avgCompletion = tracks.length 
    ? Math.round(tracks.reduce((s, t) => s + t.pct, 0) / tracks.length) 
    : 0;

  return (
    <Reorder.Item 
      value={project}
      className="bg-studio-base border border-studio-border rounded-xl p-5 hover:border-studio-muted transition-colors group relative"
    >
      <div className="flex items-center justify-between mb-4">
        <div className="flex items-center gap-3 min-w-0">
          <div className="text-studio-muted hover:text-studio-text cursor-grab active:cursor-grabbing">
            <GripVertical className="w-4 h-4" />
          </div>
          <div className="min-w-0">
            <h3 className="text-base font-medium truncate">{project.name}</h3>
            <div className="text-xs text-studio-muted mt-0.5 truncate">
              {project.artist && <span>{project.artist} • </span>}
              {tracks.length} tracks
            </div>
          </div>
        </div>
        <div className="flex gap-1 opacity-0 group-hover:opacity-100 transition-opacity shrink-0">
          <button onClick={onEdit} className="p-2 text-studio-muted hover:text-studio-text transition-colors"><Edit3 className="w-4 h-4" /></button>
          <button onClick={onDelete} className="p-2 text-studio-muted hover:text-red-400 transition-colors"><Trash2 className="w-4 h-4" /></button>
        </div>
      </div>

      <div className="space-y-4">
        <div className="space-y-2">
          <div className="flex justify-between items-center text-[10px] uppercase tracking-widest text-studio-muted font-bold">
            <span>Overall Progress</span>
            <span className="font-mono text-studio-text">{avgCompletion}%</span>
          </div>
          <div className="h-2 bg-studio-raised rounded-full overflow-hidden">
            <motion.div 
              initial={{ width: 0 }}
              animate={{ width: `${avgCompletion}%` }}
              className="h-full bg-studio-accent"
            />
          </div>
        </div>

        {tracks.length > 0 && (
          <div className="space-y-2 pt-2 border-t border-studio-border">
            {tracks.slice(0, 3).map(track => (
              <div key={track.id} className="flex items-center gap-3 text-xs">
                <div className={cn("w-1.5 h-1.5 rounded-full", track.done ? "bg-studio-accent" : "bg-studio-muted")} />
                <span className={cn("flex-1 truncate", track.done && "line-through text-studio-muted")}>{track.title}</span>
                <span className="text-[10px] font-mono text-studio-muted">{track.pct}%</span>
              </div>
            ))}
            {tracks.length > 3 && (
              <div className="text-[10px] text-studio-muted">+ {tracks.length - 3} more tracks</div>
            )}
          </div>
        )}
      </div>
    </Reorder.Item>
  );
}

function Modal({ isOpen, onClose, title, children }: { isOpen: boolean; onClose: () => void; title: string; children: ReactNode }) {
  if (!isOpen) return null;
  return (
    <div className="fixed inset-0 z-50 flex items-end sm:items-center justify-center p-0 sm:p-4">
      <motion.div 
        initial={{ opacity: 0 }} 
        animate={{ opacity: 1 }} 
        exit={{ opacity: 0 }}
        onClick={onClose}
        className="absolute inset-0 bg-black/60 backdrop-blur-sm" 
      />
      <motion.div 
        initial={{ opacity: 0, y: 100, scale: 1 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        exit={{ opacity: 0, y: 100, scale: 1 }}
        className="relative bg-studio-base border-t sm:border border-studio-border rounded-t-2xl sm:rounded-2xl w-full max-w-lg shadow-2xl overflow-hidden"
      >
        <div className="px-5 md:px-6 py-4 border-b border-studio-border flex items-center justify-between">
          <h2 className="font-medium">{title}</h2>
          <button onClick={onClose} className="p-1 text-studio-muted hover:text-studio-text"><X className="w-5 h-5" /></button>
        </div>
        <div className="p-5 md:p-6 max-h-[85vh] overflow-y-auto">
          {children}
        </div>
      </motion.div>
    </div>
  );
}

function AddTrackModal({ isOpen, onClose, projects, onSave, onBulkSave, initialTrack }: { 
  isOpen: boolean; 
  onClose: () => void; 
  projects: Project[];
  onSave: (track: any) => void;
  onBulkSave: (tracks: any[], projectName: string, artist: string) => void;
  initialTrack: Track | null;
}) {
  const [activeTab, setActiveTab] = useState<'single' | 'project'>('single');
  const [title, setTitle] = useState('');
  const [artist, setArtist] = useState('');
  const [projectName, setProjectName] = useState('');
  const [projectId, setProjectId] = useState<string | null>(null);
  const [pct, setPct] = useState(0);
  const [notes, setNotes] = useState('');
  const [untitled, setUntitled] = useState('');
  const [bulkTracks, setBulkTracks] = useState<string[]>(['']);

  useEffect(() => {
    if (initialTrack) {
      setTitle(initialTrack.title);
      setArtist(initialTrack.artist);
      setProjectId(initialTrack.projectId);
      setPct(initialTrack.pct);
      setNotes(initialTrack.notes);
      setUntitled(initialTrack.untitled);
      setActiveTab('single');
    } else {
      setTitle('');
      setArtist('');
      setProjectName('');
      setProjectId(null);
      setPct(0);
      setNotes('');
      setUntitled('');
      setBulkTracks(['']);
      setActiveTab('single');
    }
  }, [initialTrack, isOpen]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (activeTab === 'single' || initialTrack) {
      if (!title.trim()) return;
      
      // If adding a single and no project selected, use the track title as project name
      if (activeTab === 'single' && !initialTrack && !projectId && !projectName) {
        onBulkSave([{ title, artist, projectId: null, pct, notes, untitled, done: false }], title, artist);
      } else {
        onSave({ title, artist, projectId, pct, notes, untitled, done: false });
      }
    } else {
      const titles = bulkTracks.filter(t => t.trim());
      if (titles.length === 0) return;
      
      const tracks = titles.map(t => ({
        title: t,
        artist: artist,
        projectId: projectId,
        pct: 0,
        notes: '',
        untitled: untitled,
        done: false
      }));
      
      onBulkSave(tracks, projectName, artist);
    }
    onClose();
  };

  const selectedProject = projectId ? projects.find(p => p.id === projectId) : null;
  const inheritedArtist = selectedProject?.artist || '';

  const addRow = () => setBulkTracks([...bulkTracks, '']);
  const updateRow = (i: number, v: string) => {
    const next = [...bulkTracks];
    next[i] = v;
    setBulkTracks(next);
  };
  const removeRow = (i: number) => {
    if (bulkTracks.length > 1) {
      setBulkTracks(bulkTracks.filter((_, idx) => idx !== i));
    }
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={initialTrack ? "Edit Track" : "Add Music"}>
      <div className="space-y-6">
        {!initialTrack && (
          <div className="flex bg-studio-base p-1 rounded-lg border border-studio-border">
            <button 
              type="button"
              onClick={() => setActiveTab('single')}
              className={cn(
                "flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all flex items-center justify-center gap-2 uppercase tracking-wider",
                activeTab === 'single' ? "bg-studio-raised text-studio-accent shadow-sm border border-studio-border" : "text-studio-muted hover:text-studio-text"
              )}
            >
              <Music className="w-3 h-3" />
              Single
            </button>
            <button 
              type="button"
              onClick={() => setActiveTab('project')}
              className={cn(
                "flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all flex items-center justify-center gap-2 uppercase tracking-wider",
                activeTab === 'project' ? "bg-studio-raised text-studio-text shadow-sm border border-studio-border" : "text-studio-muted hover:text-studio-text"
              )}
            >
              <FolderKanban className="w-3 h-3" />
              Project / EP
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5 flex-1">
              <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold block">Project</label>
              {activeTab === 'project' && !initialTrack ? (
                 <input 
                    type="text" 
                    value={projectName} 
                    onChange={e => setProjectName(e.target.value)}
                    className="w-full bg-studio-raised border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent"
                    placeholder="New or existing project"
                 />
              ) : (
                <select 
                  value={projectId || ''} 
                  onChange={e => setProjectId(e.target.value || null)}
                  className="w-full bg-studio-raised border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent"
                >
                  <option value="">No Project</option>
                  {projects.map(p => <option key={p.id} value={p.id}>{p.name}</option>)}
                </select>
              )}
            </div>
            <div className="space-y-1.5 flex-1">
              <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold block">Artist</label>
              <input 
                type="text" 
                value={artist} 
                onChange={e => setArtist(e.target.value)}
                className="w-full bg-studio-raised border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent"
                placeholder={inheritedArtist || "Artist name"}
              />
            </div>
          </div>

          {activeTab === 'single' || initialTrack ? (
            <div className="space-y-4 pt-4 border-t border-studio-border">
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">
                  {activeTab === 'single' && !projectId ? 'Title *' : 'Track Title *'}
                </label>
                <input 
                  autoFocus
                  type="text" 
                  value={title} 
                  onChange={e => setTitle(e.target.value)}
                  className="w-full bg-studio-base border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent"
                  placeholder={activeTab === 'single' && !projectId ? "e.g. Moonlight Drive" : "Track title"}
                  required
                />
              </div>
              <div className="space-y-1.5">
                <div className="flex justify-between items-center text-[10px] font-bold uppercase tracking-widest text-studio-muted">
                  <span>Progress</span>
                  <span className="font-mono text-studio-text">{pct}%</span>
                </div>
                <input 
                  type="range" 
                  min="0" max="100" 
                  value={pct}
                  onChange={e => setPct(parseInt(e.target.value))}
                  className="w-full accent-studio-accent bg-studio-border h-1 rounded-full appearance-none cursor-pointer"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Untitled Link</label>
                <input 
                  type="url" 
                  value={untitled} 
                  onChange={e => setUntitled(e.target.value)}
                  className="w-full bg-studio-base border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent"
                  placeholder="untitled://..."
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Notes</label>
                <textarea 
                  value={notes} 
                  onChange={e => setNotes(e.target.value)}
                  className="w-full bg-studio-base border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent min-h-[80px] resize-none"
                  placeholder="Notes, feedback..."
                />
              </div>
            </div>
          ) : (
            <div className="space-y-3 pt-4 border-t border-studio-border">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Tracks</label>
                <span className="text-[10px] font-mono text-studio-muted">{bulkTracks.length} tracks</span>
              </div>
              <div className="space-y-2 max-h-[300px] overflow-y-auto pr-1">
                {bulkTracks.map((t, idx) => (
                  <div key={idx} className="flex gap-2">
                    <div className="flex-1 relative">
                      <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-studio-muted w-4">{idx + 1}</span>
                      <input 
                        type="text"
                        value={t}
                        onChange={e => updateRow(idx, e.target.value)}
                        placeholder="Title"
                        className="w-full bg-studio-base border border-studio-border rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none focus:border-studio-accent"
                      />
                    </div>
                    {bulkTracks.length > 1 && (
                      <button type="button" onClick={() => removeRow(idx)} className="p-1.5 text-studio-muted hover:text-red-400">
                        <X className="w-4 h-4" />
                      </button>
                    )}
                  </div>
                ))}
                <button 
                  type="button"
                  onClick={addRow}
                  className="w-full py-1.5 border border-dashed border-studio-border rounded-lg text-xs text-studio-muted hover:text-studio-accent transition-colors flex items-center justify-center gap-2"
                >
                  <Plus className="w-3 h-3" />
                  Add Track
                </button>
              </div>
            </div>
          )}

          <div className="pt-4">
            <button type="submit" className="w-full py-3 bg-white text-black font-bold rounded-xl hover:opacity-90 transition-opacity flex items-center justify-center gap-2 shadow-lg">
              {initialTrack ? "Update Track" : (activeTab === 'single' ? "Add Track to Stack" : `Create ${bulkTracks.filter(t => t.trim()).length} tracks`)}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}

function AddProjectModal({ isOpen, onClose, onSave, onSaveWithTracks, initialProject }: { 
  isOpen: boolean; 
  onClose: () => void; 
  onSave: (project: Omit<Project, 'id'>) => void; 
  onSaveWithTracks: (project: Omit<Project, 'id'>, tracks: string[]) => void;
  initialProject: Project | null;
}) {
  const [activeTab, setActiveTab] = useState<'single' | 'project'>('project');
  const [name, setName] = useState('');
  const [artist, setArtist] = useState('');
  const [notes, setNotes] = useState('');
  const [tracks, setTracks] = useState<string[]>(['']);

  useEffect(() => {
    if (initialProject) {
      setName(initialProject.name);
      setArtist(initialProject.artist);
      setNotes(initialProject.notes);
      setActiveTab('project');
    } else {
      setName('');
      setArtist('');
      setNotes('');
      setTracks(['']);
      setActiveTab('project');
    }
  }, [initialProject, isOpen]);

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    
    if (initialProject) {
      onSave({ name, artist, notes });
    } else {
      if (activeTab === 'single') {
        onSaveWithTracks({ name, artist, notes }, name.trim() ? [name] : []);
      } else {
        const validTracks = tracks.filter(t => t.trim());
        onSaveWithTracks({ name, artist, notes }, validTracks);
      }
    }
    onClose();
  };

  const addTrack = () => setTracks([...tracks, '']);
  const updateTrack = (i: number, v: string) => {
    const next = [...tracks];
    next[i] = v;
    setTracks(next);
  };
  const removeTrack = (i: number) => {
    if (tracks.length > 1) setTracks(tracks.filter((_, idx) => idx !== i));
  };

  return (
    <Modal isOpen={isOpen} onClose={onClose} title={initialProject ? "Edit Project" : "New Collection"}>
      <div className="space-y-6">
        {!initialProject && (
          <div className="flex bg-studio-base p-1 rounded-lg border border-studio-border">
            <button 
              type="button"
              onClick={() => setActiveTab('single')}
              className={cn(
                "flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all flex items-center justify-center gap-2 uppercase tracking-wider",
                activeTab === 'single' ? "bg-studio-raised text-studio-accent shadow-sm border border-studio-border" : "text-studio-muted hover:text-studio-text"
              )}
            >
              <Music className="w-3 h-3" />
              Single
            </button>
            <button 
              type="button"
              onClick={() => setActiveTab('project')}
              className={cn(
                "flex-1 py-1.5 text-[10px] font-bold rounded-md transition-all flex items-center justify-center gap-2 uppercase tracking-wider",
                activeTab === 'project' ? "bg-studio-raised text-studio-text shadow-sm border border-studio-border" : "text-studio-muted hover:text-studio-text"
              )}
            >
              <FolderKanban className="w-3 h-3" />
              EP / Album
            </button>
          </div>
        )}

        <form onSubmit={handleSubmit} className="space-y-6">
          <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
            <div className="space-y-1.5 flex-1">
              <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">
                {activeTab === 'single' ? 'Title *' : 'Project Name *'}
              </label>
              <div className="relative">
                {activeTab === 'single' ? (
                  <Music className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-studio-muted" />
                ) : (
                  <FolderKanban className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-studio-muted" />
                )}
                <input 
                  autoFocus
                  type="text" 
                  value={name} 
                  onChange={e => setName(e.target.value)}
                  className="w-full bg-studio-raised border border-studio-border rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-studio-accent"
                  placeholder={activeTab === 'single' ? "e.g. Moonlight Drive" : "e.g. Free Range EP"}
                  required
                />
              </div>
            </div>
            <div className="space-y-1.5 flex-1">
              <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Main Artist</label>
              <div className="relative">
                <Music className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-studio-muted" />
                <input 
                  type="text" 
                  value={artist} 
                  onChange={e => setArtist(e.target.value)}
                  className="w-full bg-studio-raised border border-studio-border rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-studio-accent"
                  placeholder="Artist name"
                />
              </div>
            </div>
          </div>

          {!initialProject && activeTab === 'project' && (
            <div className="space-y-3 pt-4 border-t border-studio-border">
              <>
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Tracks</label>
                  <span className="text-[10px] font-mono text-studio-muted">{tracks.filter(t => t.trim()).length} tracks</span>
                </div>
                <div className="space-y-2 max-h-[240px] overflow-y-auto pr-1">
                  {tracks.map((t, idx) => (
                    <div key={idx} className="flex gap-2">
                      <div className="flex-1 relative">
                        <span className="absolute left-3 top-1/2 -translate-y-1/2 text-[10px] font-mono text-studio-muted w-4">{idx + 1}</span>
                        <input 
                          type="text"
                          value={t}
                          onChange={e => updateTrack(idx, e.target.value)}
                          placeholder="Track title"
                          className="w-full bg-studio-base border border-studio-border rounded-lg pl-8 pr-3 py-1.5 text-sm outline-none focus:border-studio-accent"
                        />
                      </div>
                      {tracks.length > 1 && (
                        <button type="button" onClick={() => removeTrack(idx)} className="p-1.5 text-studio-muted hover:text-red-400">
                          <X className="w-4 h-4" />
                        </button>
                      )}
                    </div>
                  ))}
                  <button 
                    type="button"
                    onClick={addTrack}
                    className="w-full py-1.5 border border-dashed border-studio-border rounded-lg text-xs text-studio-muted hover:text-studio-accent transition-colors flex items-center justify-center gap-2"
                  >
                    <Plus className="w-3 h-3" />
                    Add Track
                  </button>
                </div>
              </>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Project Notes</label>
            <textarea 
              value={notes} 
              onChange={e => setNotes(e.target.value)}
              className="w-full bg-studio-raised border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent min-h-[80px] resize-none"
              placeholder="Vision, deadlines, etc..."
            />
          </div>

          <div className="pt-4">
            <button type="submit" className="w-full py-3 bg-white text-black font-bold rounded-xl hover:opacity-90 transition-opacity flex items-center justify-center gap-2 shadow-lg">
              {initialProject ? "Save Project" : (activeTab === 'single' ? "Create Single Project" : "Create Project with Tracks")}
            </button>
          </div>
        </form>
      </div>
    </Modal>
  );
}
