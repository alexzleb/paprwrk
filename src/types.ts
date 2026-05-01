export interface Project {
  id: string;
  name: string;
  artist: string;
  notes: string;
  ownerId?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface Track {
  id: string;
  title: string;
  artist: string; // Direct artist override
  projectId: string | null;
  pct: number;
  notes: string;
  untitled: string; // URL
  done: boolean;
  ownerId?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface AppState {
  tracks: Track[];
  projects: Project[];
}
