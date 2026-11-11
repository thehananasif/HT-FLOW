import { registerModule, type ModuleViewProps } from '../registry';
import { TapeView } from './TapeView';

/** P16 Smart Tape: Time & Sales with smart-print reconstruction, filters and big-print alerts. */
registerModule({
  id: 'smart-tape',
  view: function SmartTape(props: ModuleViewProps) {
    return <TapeView {...props} variant="smart" />;
  },
});
