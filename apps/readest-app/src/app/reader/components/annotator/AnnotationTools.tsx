import { IconType } from 'react-icons';
import { FiSearch } from 'react-icons/fi';
import { FiCopy } from 'react-icons/fi';
import { FiLink } from 'react-icons/fi';
import { FiShare } from 'react-icons/fi';
import { FiSlash } from 'react-icons/fi';
import { FiSquare } from 'react-icons/fi';
import { FiType } from 'react-icons/fi';
import { PiHighlighterFill } from 'react-icons/pi';
import { LuBookA } from 'react-icons/lu';
import { BsPencilSquare } from 'react-icons/bs';
import { BsTranslate } from 'react-icons/bs';
import { FaHeadphones } from 'react-icons/fa6';
import { IoIosBuild } from 'react-icons/io';
import { AnnotationToolType, PdfDrawToolType } from '@/types/annotator';
import { stubTranslation as _ } from '@/utils/misc';

type AnnotationToolButton<T extends AnnotationToolType = AnnotationToolType> = {
  type: T;
  label: string;
  tooltip: string;
  Icon: IconType;
  quickAction?: boolean;
};

// The selection popup's tools are a closed set keyed by AnnotationToolType
// minus the PDF drawing tools, which are page-drawing modes rather than
// selection actions — the factory's exhaustiveness check runs against the
// selection subset only.
type SelectionToolType = Exclude<AnnotationToolType, PdfDrawToolType>;

function createAnnotationToolButtons<T extends SelectionToolType>(
  buttons: {
    [K in T]: {
      type: K;
      label: string;
      tooltip: string;
      Icon: IconType;
      quickAction?: boolean;
    };
  }[T][],
): AnnotationToolButton<T>[] {
  return buttons;
}

export const annotationToolButtons = createAnnotationToolButtons([
  {
    type: 'copy',
    label: _('Copy'),
    tooltip: _('Copy text after selection'),
    Icon: FiCopy,
    quickAction: true,
  },
  {
    type: 'copylink',
    label: _('Copy Link'),
    tooltip: _('Copy link to text after selection'),
    Icon: FiLink,
  },
  {
    type: 'highlight',
    label: _('Highlight'),
    tooltip: _('Highlight text after selection'),
    Icon: PiHighlighterFill,
    quickAction: true,
  },
  {
    type: 'annotate',
    label: _('Annotate'),
    tooltip: _('Annotate text after selection'),
    Icon: BsPencilSquare,
  },
  {
    type: 'search',
    label: _('Search'),
    tooltip: _('Search text after selection'),
    Icon: FiSearch,
    quickAction: true,
  },
  {
    type: 'dictionary',
    label: _('Dictionary'),
    tooltip: _('Look up text in dictionary after selection'),
    Icon: LuBookA,
    quickAction: true,
  },
  {
    type: 'translate',
    label: _('Translate'),
    tooltip: _('Translate text after selection'),
    Icon: BsTranslate,
    quickAction: true,
  },
  {
    type: 'tts',
    label: _('Speak'),
    tooltip: _('Read text aloud after selection'),
    Icon: FaHeadphones,
    quickAction: true,
  },
  {
    type: 'proofread',
    label: _('Proofread'),
    tooltip: _('Proofread text after selection'),
    Icon: IoIosBuild,
  },
  {
    type: 'share',
    label: _('Share'),
    tooltip: _('Share text after selection'),
    Icon: FiShare,
    quickAction: true,
  },
]);

export const annotationToolQuickActions = annotationToolButtons.filter(
  (button) => button.quickAction,
);

// PDF page-drawing tools (Acrobat-style line/rect/text). One-shot: armed from
// the quick-action menu, they capture the next page gesture and disarm after
// the stroke commits. PDF books only, hence excluded from the selection
// popup's tool set above.
export const pdfDrawingToolButtons: AnnotationToolButton<PdfDrawToolType>[] = [
  {
    type: 'pdf-line',
    label: _('Line'),
    tooltip: _('Draw a line on the page'),
    Icon: FiSlash,
    quickAction: true,
  },
  {
    type: 'pdf-rect',
    label: _('Rectangle'),
    tooltip: _('Draw a rectangle on the page'),
    Icon: FiSquare,
    quickAction: true,
  },
  {
    type: 'pdf-text',
    label: _('Text'),
    tooltip: _('Add a text annotation on the page'),
    Icon: FiType,
    quickAction: true,
  },
];

export const allAnnotationToolButtons: AnnotationToolButton[] = [
  ...annotationToolButtons,
  ...pdfDrawingToolButtons,
];
