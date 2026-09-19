// PDF-only drawing tools (line/rect/text). Not selection actions: they arm a
// one-shot page-drawing mode instead of applying to a text selection.
// 'pdf-select' arms a persistent editor for existing drawings.
export type PdfDrawToolType = 'pdf-line' | 'pdf-rect' | 'pdf-text' | 'pdf-select';

export type AnnotationToolType =
  | 'copy'
  | 'copylink'
  | 'highlight'
  | 'annotate'
  | 'search'
  | 'dictionary'
  | 'translate'
  | 'tts'
  | 'proofread'
  | 'share'
  | PdfDrawToolType;
