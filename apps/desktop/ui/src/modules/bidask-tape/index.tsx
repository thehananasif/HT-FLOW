import { registerModule, type ModuleViewProps } from '../registry';
import { TapeView } from '../smart-tape/TapeView';

/** P16 / P38 Bid/Ask Tape: split tape — sells grow left, buys grow right, speed meter. */
registerModule({
  id: 'bidask-tape',
  view: function BidAskTape(props: ModuleViewProps) {
    return <TapeView {...props} variant="bidask" />;
  },
});
