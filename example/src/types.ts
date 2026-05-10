export type Message = {
  id: string;
  role: 'user' | 'assistant' | 'system';
  text: string;
  chunks?: string[];
  streaming?: boolean;
};
