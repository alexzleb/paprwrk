export interface Project {
  id: string;
  name: string;
  artist: string;
  notes: string;
  link?: string;
  order?: number;
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
  order: number;
  ownerId?: string;
  createdAt?: any;
  updatedAt?: any;
}

export interface AppState {
  tracks: Track[];
  projects: Project[];
}
