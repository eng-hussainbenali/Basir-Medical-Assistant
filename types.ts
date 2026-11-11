export interface Medicine {
  id: string;
  name: string;
  dosage: string;
  frequency: string;
  purpose: string;
  warning?: string;
  reminderTime?: string; // e.g. "09:00"
  reminderEnabled?: boolean;
  userId?: string;
  createdAt?: string;
}

export interface AnalysisResult {
  name: string;
  activeIngredients: string[];
  usage: string;
  warnings: string;
  interactions: string;
  isCompatible: boolean;
}

export interface ChatMessage {
  role: 'user' | 'model';
  text: string;
}

export enum AppView {
  SCANNER = 'scanner',
  PROFILE = 'profile',
  CHAT = 'chat'
}
