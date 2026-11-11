import { registerModule } from '../registry';
import { DataManager } from './view';

registerModule({
  id: 'data-manager',
  label: 'Data manager',
  view: function DataManagerWindow() {
    return (
      <div className="module-window">
        <DataManager />
      </div>
    );
  },
});
