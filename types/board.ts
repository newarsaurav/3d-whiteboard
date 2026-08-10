export interface Board {
  id: number;
  name: string;
  drawing: string | null;

  generatedText: string;
  generatedTextVersion: number;
}