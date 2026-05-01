import { useState, useEffect, useMemo, ReactNode, FormEvent, useRef, ChangeEvent } from 'react';
import { Plus, Download, Archive, FolderKanban, Layers, Filter, X, ExternalLink, GripVertical, CheckCircle2, RotateCcw, Trash2, Edit3, Music, LogIn, LogOut, User as UserIcon, Loader2, GripHorizontal, ChevronDown, Headphones } from 'lucide-react';
import { motion, AnimatePresence, Reorder, useDragControls } from 'motion/react';
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
  getDocs,
  deleteField
} from 'firebase/firestore';

const STORAGE_KEY = 'producer_stack_react_v1';

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [authLoading, setAuthLoading] = useState(true);
  const [tracks, setTracks] = useState<Track[]>([]);
  const [projects, setProjects] = useState<Project[]>([]);
  const [projectsLoaded, setProjectsLoaded] = useState(false);
  const [tracksLoaded, setTracksLoaded] = useState(false);
  const [syncError, setSyncError] = useState<string | null>(null);
  const dataLoading = !projectsLoaded || !tracksLoaded;

  const [activeTab, setActiveTab] = useState<'stack' | 'projects' | 'archive'>('stack');
  const [expandedId, setExpandedId] = useState<string | null>(null);
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
      setTracksLoaded(false);
      setProjectsLoaded(false);
      return;
    }

    const qProjects = query(collection(db, 'projects'), where('ownerId', '==', user.uid));
    const qTracks = query(collection(db, 'tracks'), where('ownerId', '==', user.uid));

    const unsubProjects = onSnapshot(qProjects, { includeMetadataChanges: true }, (snapshot) => {
      const p = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) } as Project));
      console.log(`[STATE] Projects updated: ${p.length} docs`);
      setProjects(p);
      setProjectsLoaded(true);
      setSyncError(null);
    }, (err) => {
      console.error("Firestore Projects Error:", err);
      setSyncError("Cloud sync interrupted. Check your internet or permissions.");
      handleFirestoreError(err, OperationType.LIST, 'projects');
    });

    const unsubTracks = onSnapshot(qTracks, { includeMetadataChanges: true }, (snapshot) => {
      const t = snapshot.docs.map(doc => ({ id: doc.id, ...doc.data({ serverTimestamps: 'estimate' }) } as Track));
      console.log(`[STATE] Tracks updated: ${t.length} docs (snapshot), total tracks state currently: ${tracks.length}`);
      setTracks(t);
      setTracksLoaded(true);
      setSyncError(null);
    }, (err) => {
      console.error("Firestore Tracks Error:", err);
      setSyncError("Cloud sync interrupted. Check your internet or permissions.");
      handleFirestoreError(err, OperationType.LIST, 'tracks');
    });

    return () => {
      unsubProjects();
      unsubTracks();
    };
  }, [user?.uid]);

  // Handle migration from localStorage
  useEffect(() => {
    async function migrate() {
      // Temporarily disabled to debug tracks issue
      return;
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
    let result = tracks.filter(t => {
      // Explicitly handle 'done' as a boolean check
      const isActuallyDone = t.done === true;
      if (activeTab === 'stack' && isActuallyDone) return false;
      if (activeTab === 'archive' && !isActuallyDone) return false;
      
      const artistMatch = !filterArtist || getArtist(t) === filterArtist;
      const projectMatch = filterProject === null || t.projectId === filterProject;
      
      return artistMatch && projectMatch;
    });

    // Sort: Older first, Newest at bottom
    const sorted = [...result].sort((a, b) => {
      const orderA = a.order ?? 0;
      const orderB = b.order ?? 0;
      if (orderA !== orderB) return orderA - orderB;
      
      const getTime = (val: any) => {
        if (!val) return 0;
        if (typeof val.toMillis === 'function') return val.toMillis();
        if (typeof val.seconds === 'number') return val.seconds * 1000;
        return 0;
      };

      return getTime(a.createdAt) - getTime(b.createdAt);
    });

    console.log(`[UI] Filtered tracks: ${sorted.length}/${tracks.length}. Active Tab: ${activeTab}`);
    return sorted;
  }, [tracks, activeTab, filterArtist, filterProject, projectsMap]);

  const artists = useMemo(() => {
    const set = new Set(tracks.map(t => getArtist(t)).filter(Boolean));
    return Array.from(set);
  }, [tracks, projectsMap]);

  // Handlers
  const addTrack = async (track: Omit<Track, 'id' | 'order'>) => {
    if (!user) return;
    console.log(`[UI] Adding track: ${track.title}`);
    try {
      const maxOrder = tracks.reduce((max, t) => Math.max(max, t.order || 0), 0);
      await addDoc(collection(db, 'tracks'), {
        ...track,
        order: maxOrder + 1,
        ownerId: user.uid,
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
      console.log(`[UI] Track addDoc promise resolved successfully`);
    } catch (err) {
      console.error(`[UI] Track addDoc failed:`, err);
      handleFirestoreError(err, OperationType.WRITE, 'tracks');
    }
  };

  const reorderTracks = async (newOrder: Track[]) => {
    if (!user) return;
    
    // Update local state for immediate feedback
    const updatedTracks = tracks.map(t => {
      const found = newOrder.find(nt => nt.id === t.id);
      if (found) {
        return { ...t, order: newOrder.indexOf(found) };
      }
      return t;
    });
    setTracks(updatedTracks);

    // Sync to Firestore
    try {
      const batch = writeBatch(db);
      newOrder.forEach((track, idx) => {
        batch.update(doc(db, 'tracks', track.id), {
          order: idx,
          updatedAt: serverTimestamp()
        });
      });
      await batch.commit();
    } catch (err) {
      console.error("Failed to sync new order:", err);
      handleFirestoreError(err, OperationType.WRITE, 'tracks/batch-reorder');
    }
  };

  const reorderProjects = async (newOrder: Project[]) => {
    if (!user) return;
    
    // Update local state for immediate feedback
    const updatedProjects = projects.map(p => {
      const found = newOrder.find(np => np.id === p.id);
      if (found) {
        return { ...p, order: newOrder.indexOf(found) };
      }
      return p;
    });
    setProjects(updatedProjects);

    // Sync to Firestore
    try {
      const batch = writeBatch(db);
      newOrder.forEach((project, idx) => {
        batch.update(doc(db, 'projects', project.id), {
          order: idx,
          updatedAt: serverTimestamp()
        });
      });
      await batch.commit();
    } catch (err) {
      console.error("Failed to sync project order:", err);
      handleFirestoreError(err, OperationType.WRITE, 'projects/batch-reorder');
    }
  };

  const sortedProjects = useMemo(() => {
    return [...projects].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  }, [projects]);

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
    try {
      console.log(`[UI] Deleting track: ${id}`);
      await deleteDoc(doc(db, 'tracks', id));
    } catch (err) {
      console.error(`[UI] Delete track failed:`, err);
      handleFirestoreError(err, OperationType.DELETE, `tracks/${id}`);
    }
  };

  const addProject = async (project: Omit<Project, 'id'>) => {
    if (!user) return;
    try {
      const maxOrder = projects.reduce((max, p) => Math.max(max, p.order || 0), 0);
      await addDoc(collection(db, 'projects'), {
        ...project,
        order: maxOrder + 1,
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
    const project = projects.find(p => p.id === id);
    if (!project) return;

    try {
      console.log(`[UI] Deleting project: ${id}`);
      setSyncError(null);
      
      const batch = writeBatch(db);
      batch.delete(doc(db, 'projects', id));
      
      const relatedTracks = tracks.filter(t => t.projectId === id);
      console.log(`[UI] Unlinking ${relatedTracks.length} tracks`);
      
      relatedTracks.forEach(t => {
        batch.update(doc(db, 'tracks', t.id), { 
          projectId: deleteField(),
          updatedAt: serverTimestamp() 
        });
      });
      
      await batch.commit();
      console.log(`[UI] Project and ${relatedTracks.length} tracks successfully updated in batch`);
    } catch (err) {
      console.error(`[UI] Project deletion failed:`, err);
      setSyncError("Failed to delete project. Please try again.");
      handleFirestoreError(err, OperationType.WRITE, 'deleteProjectBatch');
    }
  };

  if (authLoading) {
    return (
      <div className="min-h-screen bg-studio-bg" />
    );
  }

  if (!user) {
    return (
      <div className="min-h-screen bg-studio-bg flex flex-col items-center justify-center p-6 text-center">
        <motion.div 
          initial={{ opacity: 0, scale: 0.9 }}
          animate={{ opacity: 1, scale: 1 }}
          className="mb-8"
        >
          <div className="relative inline-block">
            <Layers className="w-16 h-16 text-studio-accent mx-auto mb-4" />
          </div>
          <h1 className="text-4xl font-bold tracking-tight mb-2">paprwrk</h1>
          <p className="text-studio-muted text-sm max-w-[280px] mx-auto">The technical workspace for music producers.</p>
        </motion.div>
        
        <button 
          onClick={loginWithGoogle}
          className="flex items-center gap-3 px-8 py-4 bg-white text-black font-bold rounded-xl hover:opacity-90 transition-all shadow-xl shadow-white/5 active:scale-95 group"
        >
          <LogIn className="w-5 h-5 transition-transform group-hover:translate-x-1" />
          Sign in with Google
        </button>
        
        <p className="mt-12 text-[10px] text-studio-muted uppercase tracking-widest max-w-xs font-bold opacity-50">
          Built for producers • Cloud Synced • Technical Track Workspace
        </p>
      </div>
    );
  }

  return (
    <div className="min-h-screen font-sans selection:bg-studio-accent selection:text-studio-bg">
      {/* Header */}
      <header className="sticky top-0 z-40 bg-studio-bg/80 backdrop-blur-md border-b border-studio-border px-4 md:px-6 py-3 md:py-4 flex flex-col md:flex-row items-center justify-between gap-4 md:gap-0">
        {syncError && (
          <div className="absolute top-full left-0 right-0 bg-red-500/10 border-b border-red-500/20 py-1.5 px-4 text-[10px] text-red-400 font-bold text-center animate-pulse">
            {syncError}
          </div>
        )}
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
            <button 
              onClick={logout}
              className="p-2 text-studio-muted hover:text-studio-accent transition-colors"
            >
              <LogOut className="w-4 h-4" />
            </button>
          </div>
        </div>

        <div className="flex items-center gap-4 w-full md:w-auto">
          <nav className="flex bg-studio-base p-1 rounded-lg border border-studio-border flex-1 md:flex-none relative isolate">
            {[
              { id: 'stack', icon: Layers, label: 'stack' },
              { id: 'projects', icon: FolderKanban, label: 'projects' },
              { id: 'archive', icon: Archive, label: 'done' }
            ].map(tab => (
              <button
                key={tab.id}
                onClick={() => setActiveTab(tab.id as any)}
                className={cn(
                  "flex items-center justify-center gap-2 px-2 md:px-3 py-1.5 rounded-md text-xs md:text-sm transition-all flex-1 md:flex-none relative",
                  "hover:ring-1 hover:ring-white/20 active:scale-95 group",
                  activeTab === tab.id 
                    ? "text-studio-text" 
                    : "text-studio-muted hover:text-studio-text"
                )}
              >
                {activeTab === tab.id && (
                  <motion.div 
                    layoutId="activeTab"
                    className="absolute inset-0 bg-studio-raised border border-studio-border shadow-sm rounded-md -z-10"
                    transition={{ type: "spring", duration: 0.5, bounce: 0.15 }}
                  />
                )}
                <tab.icon className="w-3.5 h-3.5 md:w-4 md:h-4 shrink-0 relative z-10" />
                <span className="hidden sm:inline relative z-10">{tab.label}</span>
                <span className="sm:hidden relative z-10">{tab.label}</span>
              </button>
            ))}
          </nav>
 
          <div className="hidden md:flex items-center gap-3">
            <button 
              onClick={() => { setEditingTrack(null); setIsAddTrackOpen(true); }}
              className="flex items-center gap-2 px-4 py-2 text-sm font-bold bg-studio-accent text-studio-bg rounded-lg hover:opacity-90 transition-opacity shadow-lg shadow-studio-accent/20"
            >
              <Plus className="w-4 h-4" />
              <span>ADD TRACKS</span>
            </button>
            <div className="h-8 w-[1px] bg-studio-border mx-1" />
            <button 
              onClick={logout}
              title="Sign out"
              className="flex items-center gap-2 p-2 text-studio-muted hover:text-red-400 transition-colors"
            >
              <LogOut className="w-4 h-4" />
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
                values={filteredTracks} 
                onReorder={reorderTracks}
                className="space-y-3"
              >
                {filteredTracks.map((track, i) => (
                  <DraggableTrackItem 
                    key={track.id}
                    track={track} 
                    index={i} 
                    project={track.projectId ? projectsMap[track.projectId] : undefined}
                    artist={getArtist(track)}
                    onUpdate={(u) => updateTrack(track.id, u)}
                    onDelete={() => deleteTrack(track.id)}
                    onEdit={() => { setEditingTrack(track); setIsAddTrackOpen(true); }}
                    isTop={i === 0 && !filterArtist && !filterProject}
                    isExpanded={expandedId === track.id}
                    onToggle={() => setExpandedId(expandedId === track.id ? null : track.id)}
                  />
                ))}
              </Reorder.Group>
              {filteredTracks.length === 0 && (
                  <div className="py-20 text-center border border-dashed border-studio-border rounded-2xl">
                    <Layers className="w-10 h-10 text-studio-muted mx-auto mb-3 opacity-20" />
                    <p className="text-studio-muted text-sm px-10">
                      {tracksLoaded ? "No music in this view yet." : "Syncing your studio..."}
                    </p>
                  </div>
                )}
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

          <div className="space-y-3">
            <Reorder.Group 
              axis="y" 
              values={sortedProjects} 
              onReorder={reorderProjects}
              className="space-y-3"
            >
              {sortedProjects.map(project => (
                <DraggableProjectItem 
                  key={project.id}
                  project={project}
                  tracks={tracks.filter(t => t.projectId === project.id)}
                  onEdit={() => { setEditingProject(project); setIsAddProjectOpen(true); }}
                  onDelete={() => deleteProject(project.id)}
                  isExpanded={expandedId === project.id}
                  onToggle={() => setExpandedId(expandedId === project.id ? null : project.id)}
                />
              ))}
            </Reorder.Group>
          </div>

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
                  <ArchiveTrackRow 
                    key={track.id} 
                    track={track} 
                    artist={getArtist(track)}
                    project={track.projectId ? projectsMap[track.projectId] : undefined}
                    onRestore={() => updateTrack(track.id, { done: false })}
                    onDelete={() => deleteTrack(track.id)}
                  />
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
                  const maxProjOrder = projects.reduce((max, pr) => Math.max(max, pr.order || 0), 0);
                  batch.set(newProjRef, {
                    name: projectName,
                    artist: artist || '',
                    notes: '',
                    order: maxProjOrder + 1,
                    ownerId: user.uid,
                    createdAt: serverTimestamp(),
                    updatedAt: serverTimestamp()
                  });
                }
              }
              
              bulkTracksData.forEach((t, idx) => {
                const newTrackRef = doc(collection(db, 'tracks'));
                const maxOrder = tracks.reduce((max, tr) => Math.max(max, tr.order || 0), 0);
                batch.set(newTrackRef, {
                  ...t,
                  order: maxOrder + idx + 1,
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

              const maxProjOrder = projects.reduce((max, tr) => Math.max(max, tr.order || 0), 0);
              batch.set(newProjRef, {
                ...project,
                order: maxProjOrder + 1,
                ownerId: user.uid,
                createdAt: serverTimestamp(),
                updatedAt: serverTimestamp()
              });

              trackTitles.forEach((title, idx) => {
                const newTrackRef = doc(collection(db, 'tracks'));
                const maxOrder = tracks.reduce((max, tr) => Math.max(max, tr.order || 0), 0);
                batch.set(newTrackRef, {
                  title,
                  artist: project.artist || '',
                  projectId: projectId,
                  pct: 0,
                  notes: '',
                  untitled: project.link || '',
                  done: false,
                  order: maxOrder + idx + 1,
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

function DraggableTrackItem({ 
  track, 
  index, 
  project, 
  artist, 
  onUpdate, 
  onDelete, 
  onEdit, 
  isTop, 
  isExpanded, 
  onToggle 
}: {
  track: Track;
  index: number;
  project?: Project;
  artist: string;
  onUpdate: (update: Partial<Track>) => void;
  onDelete: () => void;
  onEdit: () => void;
  isTop: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  key?: string | number;
}) {
  const dragControls = useDragControls();
  const [isDragging, setIsDragging] = useState(false);

  return (
    <Reorder.Item 
      value={track}
      dragListener={false}
      dragControls={dragControls}
      onDragStart={() => setIsDragging(true)}
      onDragEnd={() => setIsDragging(false)}
      whileDrag={{ 
        zIndex: 100,
        scale: 1.01,
        boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.5)",
      }}
      className={cn(
        "relative select-none",
        isDragging ? "z-50" : "z-0"
      )}
      style={{
        backgroundColor: isDragging ? "#151719" : "transparent"
      }}
    >
      <TrackCard 
        track={track} 
        index={index} 
        project={project}
        artist={artist}
        onUpdate={onUpdate}
        onDelete={onDelete}
        onEdit={onEdit}
        isTop={isTop}
        isExpanded={isExpanded}
        onToggle={onToggle}
        dragControls={dragControls}
      />
    </Reorder.Item>
  );
}

function TrackCard({ track, index, project, artist, onUpdate, onDelete, onEdit, isTop, isExpanded, onToggle, dragControls }: { 
  track: Track; 
  index: number; 
  project?: Project;
  artist: string;
  onUpdate: (u: Partial<Track>) => void | Promise<void>;
  onDelete: () => void | Promise<void>;
  onEdit: () => void;
  isTop?: boolean;
  isExpanded: boolean;
  onToggle: () => void;
  key?: any;
  dragControls: any;
}) {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const [localPct, setLocalPct] = useState(track.pct);

  useEffect(() => {
    setLocalPct(track.pct);
  }, [track.pct]);

  const listenLink = track.untitled || project?.link;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={cn(
        "bg-studio-base border rounded-xl overflow-hidden shadow-sm transition-all hover:border-white/20 active:ring-1 active:ring-white/10",
        isExpanded ? "border-white/20" : "border-studio-border",
        isTop && !isExpanded && "border-studio-accent/50 ring-1 ring-studio-accent/20"
      )}
    >
      <div 
        className="px-3 md:px-4 py-4.5 flex items-center gap-3 md:gap-4 relative"
      >
        <div 
          className="absolute bottom-0 left-0 h-[2px] bg-studio-accent pointer-events-none transition-all duration-1000 ease-out z-20" 
          style={{ width: `${track.pct}%` }} 
        />
        <div 
          className="absolute inset-x-0 bottom-0 h-[2px] bg-studio-accent/10 pointer-events-none z-10" 
        />
        <div 
          onPointerDown={(e) => {
            e.stopPropagation();
            dragControls.start(e);
          }}
          className="text-studio-muted hover:text-studio-text cursor-grab active:cursor-grabbing shrink-0 p-2 relative z-20 flex items-center justify-center touch-none"
        >
          <GripVertical className="w-5 h-5" />
        </div>

        <div 
          className="flex-1 min-w-0 relative z-10 cursor-pointer"
          onClick={onToggle}
        >
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1 flex flex-col justify-center">
               <div className="flex items-center gap-2">
                <h3 className="font-semibold text-sm md:text-base truncate tracking-tight">{track.title}</h3>
                {/* Listen link moved to expanded view */}
                {isTop && (
                  <span className="text-[8px] md:text-[9px] uppercase tracking-tighter bg-studio-accent text-studio-bg px-1.5 py-0.5 rounded font-bold shrink-0">Up Next</span>
                )}
              </div>
              <div className="flex items-center gap-1.5 mt-0.5 min-h-[14px]">
                {artist && (
                  <span className="text-[10px] md:text-[11px] uppercase font-bold text-studio-muted/70 tracking-wide shrink-0">
                    {artist}
                  </span>
                )}
                {artist && project && (
                  <span className="text-[10px] text-studio-muted/40 font-bold">•</span>
                )}
                {project && (
                  <span className="text-[10px] md:text-[11px] uppercase font-bold text-studio-accent/50 tracking-wide truncate max-w-[120px] md:max-w-[200px]">
                    {project.name}
                  </span>
                )}
              </div>
            </div>
            
            <div className="flex items-center gap-4 shrink-0 h-full">
              <span className="text-xs md:text-sm font-mono font-bold text-studio-accent/70 tracking-tighter">{track.pct}%</span>
              <ChevronDown className={cn("w-4 h-4 text-studio-muted transition-transform duration-300", isExpanded && "rotate-180")} />
            </div>
          </div>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", duration: 0.4, bounce: 0 }}
            className="overflow-hidden"
          >
            <div className="border-t border-studio-border px-4 py-4 space-y-4 bg-studio-raised/30">
              <div className="space-y-2">
              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Progress</label>
                <span className="text-xs font-mono">{track.pct}%</span>
              </div>
              <input 
                type="range" 
                min="0" max="100" 
                value={localPct}
                onChange={(e) => {
                  const val = parseInt(e.target.value);
                  setLocalPct(val);
                  const rounded = Math.round(val / 5) * 5;
                  if (rounded !== track.pct) onUpdate({ pct: rounded });
                }}
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
                <span>Open Link</span>
              </a>
            )}

            <div className="space-y-1.5">
              <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Notes</label>
              <AutoResizeTextarea 
                value={track.notes}
                onChange={(e) => onUpdate({ notes: e.target.value })}
                placeholder="Session thoughts, mix notes, or next steps..."
                className="w-full bg-studio-base border border-studio-border rounded-lg p-3 text-sm outline-none focus:border-studio-accent transition-colors"
                minHeight="80px"
              />
            </div>

            <div className="flex items-center justify-between pt-2 border-t border-studio-border">
              <div className="flex items-center gap-1">
                <button 
                  onClick={() => onUpdate({ done: true, pct: 100 })}
                  className="p-2 text-studio-accent hover:bg-studio-accent/10 rounded-lg transition-colors"
                  title="Mark Done"
                >
                  <CheckCircle2 className="w-4 h-4" />
                </button>
                <button 
                  onClick={onEdit}
                  className="p-2 text-studio-muted hover:text-studio-text hover:bg-studio-raised rounded-lg transition-colors"
                  title="Edit Track"
                >
                  <Edit3 className="w-4 h-4" />
                </button>
              </div>
              <div className="flex items-center gap-1">
                {listenLink && (
                  <a 
                    href={listenLink} 
                    target="_blank" 
                    rel="noopener noreferrer" 
                    onClick={e => e.stopPropagation()}
                    className="p-2 text-studio-muted hover:text-studio-accent hover:bg-studio-accent/10 rounded-lg transition-colors shrink-0"
                    title="Quick Listen"
                  >
                    <Headphones className="w-4 h-4" />
                  </a>
                )}
                <button 
                  onClick={(e) => { 
                    e.stopPropagation(); 
                    if (isConfirmingDelete) {
                      onDelete();
                    } else {
                      setIsConfirmingDelete(true);
                      setTimeout(() => setIsConfirmingDelete(false), 3000);
                    }
                  }}
                  className={cn(
                    "flex items-center justify-center transition-all relative z-10 font-bold rounded-lg shrink-0 overflow-hidden",
                    isConfirmingDelete 
                      ? "bg-red-500 text-white w-20 h-8 text-[10px]" 
                      : "text-studio-muted hover:text-red-400 h-8 w-8 hover:bg-red-400/10"
                  )}
                  title="Delete Track"
                >
                <AnimatePresence mode="wait" initial={false}>
                  {isConfirmingDelete ? (
                    <motion.span
                      key="confirm"
                      initial={{ opacity: 0, y: 10 }}
                      animate={{ opacity: 1, y: 0 }}
                      exit={{ opacity: 0, y: -10 }}
                    >
                      CONFIRM
                    </motion.span>
                  ) : (
                    <motion.div
                      key="trash"
                      initial={{ opacity: 0, scale: 0.5 }}
                      animate={{ opacity: 1, scale: 1 }}
                      exit={{ opacity: 0, scale: 0.5 }}
                    >
                      <Trash2 className="w-4 h-4" />
                    </motion.div>
                  )}
                </AnimatePresence>
              </button>
            </div>
          </div>
        </div>
      </motion.div>
    )}
  </AnimatePresence>
</motion.div>
  );
}

function DraggableProjectItem({ 
  project, 
  tracks, 
  onEdit, 
  onDelete, 
  isExpanded, 
  onToggle 
}: {
  project: Project;
  tracks: Track[];
  onEdit: () => void;
  onDelete: () => void;
  isExpanded: boolean;
  onToggle: () => void;
  key?: string | number;
}) {
  const dragControls = useDragControls();
  const [isDragging, setIsDragging] = useState(false);

  return (
    <Reorder.Item 
      value={project}
      dragListener={false}
      dragControls={dragControls}
      onDragStart={() => setIsDragging(true)}
      onDragEnd={() => setIsDragging(false)}
      whileDrag={{ 
        zIndex: 100,
        scale: 1.01,
        boxShadow: "0 25px 50px -12px rgb(0 0 0 / 0.5)",
      }}
      className={cn(
        "relative select-none",
        isDragging ? "z-50" : "z-0"
      )}
      style={{
        backgroundColor: isDragging ? "#151719" : "transparent"
      }}
    >
      <ProjectCard 
        project={project}
        tracks={tracks}
        onEdit={onEdit}
        onDelete={onDelete}
        isExpanded={isExpanded}
        onToggle={onToggle}
        dragControls={dragControls}
      />
    </Reorder.Item>
  );
}

function ProjectCard({ project, tracks, onEdit, onDelete, isExpanded, onToggle, dragControls }: { 
  project: Project; 
  tracks: Track[]; 
  onEdit: () => void; 
  onDelete: () => void | Promise<void>; 
  isExpanded: boolean;
  onToggle: () => void;
  key?: any;
  dragControls: any;
}) {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const avgCompletion = tracks.length 
    ? Math.round(tracks.reduce((s, t) => s + t.pct, 0) / tracks.length) 
    : 0;

  return (
    <motion.div 
      initial={{ opacity: 0, y: 10 }}
      animate={{ opacity: 1, y: 0 }}
      exit={{ opacity: 0, scale: 0.95 }}
      className={cn(
        "bg-studio-base border rounded-xl overflow-hidden shadow-sm transition-all hover:border-white/20 active:ring-1 active:ring-white/10",
        isExpanded ? "border-white/20 shadow-lg" : "border-studio-border"
      )}
    >
      <div className="px-3 md:px-4 py-4 md:py-4.5 flex items-start justify-between gap-3 md:gap-4 relative">
        <div 
          className="absolute bottom-0 left-0 h-[2px] bg-studio-accent pointer-events-none transition-all duration-1000 ease-out z-20" 
          style={{ width: `${avgCompletion}%` }} 
        />
        <div 
          className="absolute inset-x-0 bottom-0 h-[2px] bg-studio-accent/10 pointer-events-none z-10" 
        />
        
        <div 
          onPointerDown={(e) => {
            e.stopPropagation();
            dragControls.start(e);
          }}
          className="text-studio-muted hover:text-studio-text cursor-grab active:cursor-grabbing shrink-0 p-2 relative z-20 flex items-center justify-center touch-none self-center"
        >
          <GripVertical className="w-5 h-5" />
        </div>

        <div 
          className="flex-1 min-w-0 relative z-10 flex items-start gap-3 cursor-pointer"
          onClick={onToggle}
        >
          <div className="flex-1 min-w-0 flex flex-col">
            <div className="flex flex-col sm:flex-row sm:items-baseline gap-x-3 gap-y-0.5 min-w-0">
              <h3 className="font-semibold text-sm md:text-base truncate tracking-tight py-0.5">{project.name}</h3>
              {project.artist && (
                <span className="text-[10px] md:text-[11px] uppercase font-bold text-studio-muted/70 tracking-wide">
                  {project.artist}
                </span>
              )}
            </div>
            <div className="flex items-center gap-1.5 mt-1.5 text-[10px] md:text-[11px] font-bold uppercase tracking-wide">
                 <span className="text-studio-muted/70 shrink-0">{tracks.length} TRACKS</span>
                 <span className="text-studio-border/30 shrink-0">|</span>
                 <div className="flex items-center gap-[3px] text-studio-accent/50 shrink-0">
                  <span>{avgCompletion}%</span>
                  <span>COMPLETE</span>
                 </div>
            </div>
          </div>
        </div>

        <div className="flex items-center gap-2 md:gap-3 shrink-0 relative z-10 mt-0.5 md:mt-1">
          <div className="flex items-center gap-1 md:gap-1.5" onClick={e => e.stopPropagation()}>
            {project.link && (
              <a 
                href={project.link} 
                target="_blank" 
                rel="noopener noreferrer"
                className="p-1.5 md:p-2 text-studio-muted hover:text-studio-accent hover:bg-studio-accent/10 rounded-lg transition-colors"
                title="Quick Listen"
              >
                <Headphones className="w-4.5 h-4.5" />
              </a>
            )}
            <button 
              onClick={onEdit} 
              className="p-1.5 md:p-2 text-studio-muted hover:text-studio-text transition-colors"
              title="Edit Project"
            >
              <Edit3 className="w-4 h-4" />
            </button>
            <button 
              onClick={() => { 
                if (isConfirmingDelete) {
                  onDelete();
                } else {
                  setIsConfirmingDelete(true);
                  setTimeout(() => setIsConfirmingDelete(false), 3000);
                }
              }}
              className={cn(
                "flex items-center justify-center transition-all rounded-lg shrink-0 overflow-hidden",
                isConfirmingDelete 
                  ? "bg-red-500 text-white w-20 h-8 text-[10px] font-bold" 
                  : "text-studio-muted hover:text-red-400 h-8 w-8 hover:bg-red-400/10"
              )}
              title="Delete Project"
            >
              <AnimatePresence mode="wait" initial={false}>
                {isConfirmingDelete ? (
                  <motion.span
                    key="confirm"
                    initial={{ opacity: 0, y: 10 }}
                    animate={{ opacity: 1, y: 0 }}
                    exit={{ opacity: 0, y: -10 }}
                  >
                    CONFIRM
                  </motion.span>
                ) : (
                  <motion.div
                    key="trash"
                    initial={{ opacity: 0, scale: 0.5 }}
                    animate={{ opacity: 1, scale: 1 }}
                    exit={{ opacity: 0, scale: 0.5 }}
                  >
                    <Trash2 className="w-4 h-4" />
                  </motion.div>
                )}
              </AnimatePresence>
            </button>
          </div>
          <button 
            className="flex items-center p-1 text-studio-muted hover:text-studio-text transition-colors relative z-20"
            onClick={(e) => { e.stopPropagation(); onToggle(); }}
            title={isExpanded ? "Collapse" : "Expand"}
          >
            <ChevronDown className={cn("w-5 h-5 transition-transform duration-300", isExpanded && "rotate-180")} />
          </button>
        </div>
      </div>

      <AnimatePresence initial={false}>
        {isExpanded && (
          <motion.div
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ type: "spring", duration: 0.4, bounce: 0 }}
            className="overflow-hidden"
          >
            <div className="p-4 space-y-4 border-t border-studio-border bg-studio-raised/10">
              {project.notes && (
                <div className="bg-studio-muted/10 border border-studio-border/30 rounded-lg p-3">
                  <label className="text-[9px] uppercase tracking-widest text-studio-muted font-bold block mb-2 px-1">Notes</label>
                  <p className="text-[10px] md:text-xs text-studio-text/80 whitespace-pre-wrap px-1">{project.notes}</p>
                </div>
              )}

              <div className="space-y-3 bg-studio-muted/5 border border-studio-border/30 rounded-lg p-3">
                <label className="text-[9px] uppercase tracking-widest text-studio-muted font-bold block mb-2 px-1">Track Breakdown</label>
                <div className="space-y-1.5">
                  {tracks.length === 0 ? (
                    <p className="text-[10px] text-studio-muted italic px-1">No tracks in this project.</p>
                  ) : (
                    [...tracks].sort((a, b) => a.pct - b.pct).map(track => (
                      <div key={track.id} className="flex items-center gap-3 text-xs md:text-sm font-semibold tracking-tight relative overflow-hidden group pt-1.5 pb-[8px] px-1">
                        <div 
                          className="absolute bottom-0 left-0 h-[3px] bg-studio-accent/40 pointer-events-none transition-all duration-1000 ease-out z-20" 
                          style={{ width: `${track.pct}%` }} 
                        />
                        <div 
                          className="absolute inset-x-0 bottom-0 h-[3px] bg-studio-border/30 pointer-events-none z-10" 
                        />
                        <span className={cn("flex-1 truncate relative z-10", track.done && "line-through text-studio-muted/50")}>{track.title}</span>
                        <div className="flex items-center gap-2 relative z-10">
                          <span className="text-[10px] md:text-xs font-mono text-studio-accent/70 w-8 text-right">{track.pct}%</span>
                        </div>
                      </div>
                    ))
                  )}
                </div>
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>
    </motion.div>
  );
}

function ArchiveTrackRow({ track, artist, project, onRestore, onDelete }: { 
  track: Track; 
  artist: string; 
  project?: Project;
  onRestore: () => void | Promise<void>; 
  onDelete: () => void | Promise<void>;
  key?: any;
}) {
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const listenLink = track.untitled || project?.link;

  return (
    <div className="relative bg-studio-base border border-studio-border px-3 md:px-4 py-3 md:py-4 rounded-xl flex items-center justify-between group overflow-hidden">
      <div className="flex items-center gap-3 md:gap-4 min-w-0">
        <div className="p-2 bg-studio-accent/20 rounded-lg text-studio-accent shrink-0 flex items-center justify-center">
          <CheckCircle2 className="w-5 h-5" />
        </div>
        <div className="min-w-0 flex flex-col justify-center">
          <div className="flex items-center gap-2">
            <div className="font-semibold text-sm md:text-base truncate tracking-tight">{track.title}</div>
            {/* Listen link moved beside delete icon */}
          </div>
          <div className="flex items-center gap-1.5 mt-0.5 min-h-[14px]">
            {artist && (
              <span className="text-[10px] md:text-[11px] uppercase font-bold text-studio-muted/70 tracking-wide shrink-0">
                {artist}
              </span>
            )}
            {artist && project && (
              <span className="text-[10px] text-studio-muted/40 font-bold">•</span>
            )}
            {project && (
              <span className="text-[10px] md:text-[11px] uppercase font-bold text-studio-accent/40 tracking-wide truncate max-w-[120px]">
                {project.name}
              </span>
            )}
          </div>
        </div>
      </div>
      <div className="flex items-center gap-1 shrink-0 relative z-10">
        {!isConfirmingDelete && listenLink && (
          <a 
            href={listenLink} 
            target="_blank" 
            rel="noopener noreferrer" 
            onClick={e => e.stopPropagation()}
            className="p-2 text-studio-muted hover:text-studio-accent hover:bg-studio-accent/10 rounded-lg transition-colors"
            title="Quick Listen"
          >
            <Headphones className="w-4 h-4" />
          </a>
        )}
        {!isConfirmingDelete && (
          <button 
            onClick={(e) => { e.stopPropagation(); onRestore(); }}
            className="flex items-center justify-center text-studio-muted hover:text-studio-accent transition-colors h-8 w-8 rounded-lg"
            title="Restore"
          >
            <RotateCcw className="w-4 h-4" />
          </button>
        )}
          <button 
            onClick={(e) => { 
              e.stopPropagation(); 
              if (isConfirmingDelete) {
                onDelete();
              } else {
                setIsConfirmingDelete(true);
                setTimeout(() => setIsConfirmingDelete(false), 3000);
              }
            }}
            className={cn(
              "flex items-center justify-center transition-all rounded-lg shrink-0 overflow-hidden",
              isConfirmingDelete 
                ? "bg-red-500 text-white w-20 h-8 text-[10px] font-bold" 
                : "text-studio-muted hover:text-red-400 h-8 w-8 hover:bg-red-400/10"
            )}
            title="Delete"
          >
            <AnimatePresence mode="wait" initial={false}>
              {isConfirmingDelete ? (
                <motion.span
                  key="confirm"
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -10 }}
                >
                  CONFIRM
                </motion.span>
              ) : (
                <motion.div
                  key="trash"
                  initial={{ opacity: 0, scale: 0.5 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.5 }}
                >
                  <Trash2 className="w-4 h-4" />
                </motion.div>
              )}
            </AnimatePresence>
          </button>
      </div>
    </div>
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

function AutoResizeTextarea({ value, onChange, placeholder, className, minHeight = "80px", maxHeight }: { 
  value: string; 
  onChange: (e: ChangeEvent<HTMLTextAreaElement>) => void; 
  placeholder?: string;
  className?: string;
  minHeight?: string;
  maxHeight?: string;
}) {
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const adjustHeight = () => {
    if (textareaRef.current) {
      textareaRef.current.style.height = 'auto';
      const newHeight = Math.max(textareaRef.current.scrollHeight, parseInt(minHeight));
      if (maxHeight && newHeight > parseInt(maxHeight)) {
        textareaRef.current.style.height = `${maxHeight}`;
        textareaRef.current.style.overflowY = 'auto';
      } else {
        textareaRef.current.style.height = `${newHeight}px`;
        textareaRef.current.style.overflowY = 'hidden';
      }
    }
  };

  useEffect(() => {
    adjustHeight();
  }, [value]);

  return (
    <textarea
      ref={textareaRef}
      value={value}
      onChange={onChange}
      onInput={adjustHeight}
      placeholder={placeholder}
      className={cn("w-full resize-none scrollbar-thin scrollbar-thumb-studio-border/50 scrollbar-track-transparent", className)}
      style={{ minHeight, maxHeight }}
    />
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
  const [trackCountInput, setTrackCountInput] = useState('1');

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
      setTrackCountInput('1');
      setActiveTab('single');
    }
  }, [initialTrack, isOpen]);

  const handleTrackCountChange = (val: string) => {
    setTrackCountInput(val);
    const count = parseInt(val);
    if (!isNaN(count) && count >= 1 && count <= 50) {
      setBulkTracks(prev => {
        const next = [...prev];
        if (count > next.length) {
          return [...next, ...Array(count - next.length).fill('')];
        } else if (count < next.length) {
          return next.slice(0, count);
        }
        return next;
      });
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (activeTab === 'single' || initialTrack) {
      if (!title.trim()) return;
      
      onSave({ 
        title: title.trim(), 
        artist: artist.trim(), 
        projectId, 
        pct, 
        notes: notes.trim(), 
        untitled: untitled.trim(), 
        done: false 
      });
    } else {
      const titles = bulkTracks.filter(t => t.trim());
      if (titles.length === 0) return;
      
      const tracks = titles.map(t => ({
        title: t.trim(),
        artist: artist.trim(),
        projectId: projectId,
        pct: 0,
        notes: '',
        untitled: untitled.trim(),
        done: false
      }));
      
      onBulkSave(tracks, projectName.trim(), artist.trim());
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
                  onChange={e => {
                    const pid = e.target.value || null;
                    setProjectId(pid);
                    if (pid && !untitled) {
                      const proj = projects.find(p => p.id === pid);
                      if (proj?.link) setUntitled(proj.link);
                    }
                  }}
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
                  onChange={e => {
                    const val = parseInt(e.target.value);
                    const rounded = Math.round(val / 5) * 5;
                    setPct(rounded);
                  }}
                  className="w-full accent-studio-accent bg-studio-border h-1 rounded-full appearance-none cursor-pointer"
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Link (Untitled, Dropbox, etc)</label>
                <input 
                  type="url" 
                  value={untitled} 
                  onChange={e => setUntitled(e.target.value)}
                  className="w-full bg-studio-base border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent"
                  placeholder="https://..."
                />
              </div>
              <div className="space-y-1.5">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Notes</label>
                <AutoResizeTextarea 
                  value={notes} 
                  onChange={e => setNotes(e.target.value)}
                  className="w-full bg-studio-base border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent"
                  placeholder="Notes, feedback..."
                  maxHeight="300px"
                />
              </div>
            </div>
          ) : (
            <div className="space-y-4 pt-4 border-t border-studio-border">
              <div className="space-y-1.5 p-3 bg-studio-accent/5 border border-studio-accent/10 rounded-xl">
                <label className="text-[10px] uppercase tracking-widest text-studio-accent font-bold block mb-1">How many tracks are you adding?</label>
                <input 
                  type="number" 
                  min="1" 
                  max="50"
                  value={trackCountInput}
                  onChange={e => handleTrackCountChange(e.target.value)}
                  className="w-full bg-studio-base border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent font-mono"
                  placeholder="Quantity (e.g. 5)"
                />
              </div>

              <div className="flex items-center justify-between">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Track Titles</label>
                <span className="text-[10px] font-mono text-studio-muted">{bulkTracks.length} total</span>
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

              <div className="space-y-1.5 pt-2">
                <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Link (Applied to all)</label>
                <div className="relative">
                  <ExternalLink className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-studio-muted" />
                  <input 
                    type="url" 
                    value={untitled} 
                    onChange={e => setUntitled(e.target.value)}
                    className="w-full bg-studio-base border border-studio-border rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-studio-accent"
                    placeholder="https://..."
                  />
                </div>
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
  const [link, setLink] = useState('');
  const [tracks, setTracks] = useState<string[]>(['']);
  const [trackCountInput, setTrackCountInput] = useState('1');

  useEffect(() => {
    if (initialProject) {
      setName(initialProject.name);
      setArtist(initialProject.artist);
      setNotes(initialProject.notes);
      setLink(initialProject.link || '');
      setActiveTab('project');
    } else {
      setName('');
      setArtist('');
      setNotes('');
      setLink('');
      setTracks(['']);
      setTrackCountInput('1');
      setActiveTab('project');
    }
  }, [initialProject, isOpen]);

  const handleTrackCountChange = (val: string) => {
    setTrackCountInput(val);
    const count = parseInt(val);
    if (!isNaN(count) && count >= 1 && count <= 50) {
      setTracks(prev => {
        const next = [...prev];
        if (count > next.length) {
          return [...next, ...Array(count - next.length).fill('')];
        } else if (count < next.length) {
          return next.slice(0, count);
        }
        return next;
      });
    }
  };

  const handleSubmit = (e: FormEvent) => {
    e.preventDefault();
    if (!name.trim()) return;
    
    if (initialProject) {
      onSave({ name, artist, notes, link });
    } else {
      if (activeTab === 'single') {
        onSaveWithTracks({ name, artist, notes, link }, name.trim() ? [name] : []);
      } else {
        const validTracks = tracks.filter(t => t.trim());
        onSaveWithTracks({ name, artist, notes, link }, validTracks);
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

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Project Link (Quick Listen)</label>
            <div className="relative">
              <ExternalLink className="absolute left-3 top-1/2 -translate-y-1/2 w-3.5 h-3.5 text-studio-muted" />
              <input 
                type="url" 
                value={link} 
                onChange={e => setLink(e.target.value)}
                className="w-full bg-studio-raised border border-studio-border rounded-lg pl-9 pr-3 py-2 text-sm outline-none focus:border-studio-accent"
                placeholder="https://soundcloud.com/..."
              />
            </div>
          </div>


          {!initialProject && activeTab === 'project' && (
            <div className="space-y-4 pt-4 border-t border-studio-border">
              <div className="space-y-1.5 p-3 bg-studio-accent/5 border border-studio-accent/10 rounded-xl">
                  <label className="text-[10px] uppercase tracking-widest text-studio-accent font-bold block mb-1">How many tracks in this project?</label>
                  <input 
                    type="number" 
                    min="1" 
                    max="50"
                    value={trackCountInput}
                    onChange={e => handleTrackCountChange(e.target.value)}
                    className="w-full bg-studio-base border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent font-mono"
                    placeholder="Quantity (e.g. 5)"
                  />
              </div>

              <div className="space-y-3">
                <div className="flex items-center justify-between">
                  <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Track Titles</label>
                  <span className="text-[10px] font-mono text-studio-muted">{tracks.filter(t => t.trim()).length} total</span>
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
              </div>
            </div>
          )}

          <div className="space-y-1.5">
            <label className="text-[10px] uppercase tracking-widest text-studio-muted font-bold">Project Notes</label>
            <AutoResizeTextarea 
              value={notes} 
              onChange={e => setNotes(e.target.value)}
              className="w-full bg-studio-raised border border-studio-border rounded-lg px-3 py-2 text-sm outline-none focus:border-studio-accent"
              placeholder="Vision, deadlines, etc..."
              maxHeight="300px"
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
