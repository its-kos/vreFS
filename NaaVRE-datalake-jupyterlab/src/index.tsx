import {
  JupyterFrontEnd,
  JupyterFrontEndPlugin,
  ILayoutRestorer
} from '@jupyterlab/application';
import { ICommandPalette, MainAreaWidget } from '@jupyterlab/apputils';
import { Widget } from '@lumino/widgets';
import { createRoot, Root } from 'react-dom/client';
import * as React from 'react';
import { DataLakePanel } from './components/DataLakePanel';
import { DatasetDetailPanel } from './components/DatasetDetailPanel';
import { VreFSService } from './service';
import { vreFSIcon } from './icon';

const PLUGIN_ID = 'NaaVRE-datalake-jupyterlab:plugin';
const PANEL_ID = 'vrefs:panel';

/**
 * Lumino widget wrapping the main React DataLakePanel.
 * Lives in the left sidebar.
 */
class DataLakeWidget extends Widget {
  private _service: VreFSService;
  private _root: Root | null = null;

  constructor(service: VreFSService) {
    super();
    this._service = service;
    this.id = PANEL_ID;
    this.title.label = 'vreFS';
    this.title.caption = 'Personal Data Lake — vreFS';
    this.title.icon = vreFSIcon;
    this.addClass('vrefs-widget');
  }

  onAfterAttach(): void {
    this._root = createRoot(this.node);
    this._root.render(<DataLakePanel service={this._service} />);
  }

  onBeforeDetach(): void {
    this._root?.unmount();
    this._root = null;
  }
}

const plugin: JupyterFrontEndPlugin<void> = {
  id: PLUGIN_ID,
  description: 'vreFS — personal data lake for NaaVRE',
  autoStart: true,
  optional: [ICommandPalette, ILayoutRestorer],

  activate: (
    app: JupyterFrontEnd,
    palette: ICommandPalette | null,
    restorer: ILayoutRestorer | null
  ) => {
    const service = new VreFSService();

    // -----------------------------------------------------------------------
    // Sidebar widget
    // -----------------------------------------------------------------------
    const sidebar = new DataLakeWidget(service);
    app.shell.add(sidebar, 'left', { rank: 300 });

    // -----------------------------------------------------------------------
    // Command: open full catalogue in main area
    // -----------------------------------------------------------------------
    app.commands.addCommand('vrefs:open-catalogue', {
      label: 'vreFS: Open Data Lake',
      caption: 'Open the vreFS personal data lake catalogue',
      icon: vreFSIcon,
      execute: () => {
        const content = new Widget();
        content.addClass('vrefs-main-content');
        const root = createRoot(content.node);
        root.render(<DataLakePanel service={service} fullScreen={true} />);
        const main = new MainAreaWidget({ content });
        main.title.label = 'My Data Lake';
        main.title.icon = vreFSIcon;
        main.title.closable = true;
        app.shell.add(main, 'main');
        app.shell.activateById(main.id);
      }
    });

    // -----------------------------------------------------------------------
    // Command: open dataset detail in main area
    // -----------------------------------------------------------------------
    app.commands.addCommand('vrefs:open-dataset', {
      label: 'vreFS: Open Dataset',
      execute: (args: any) => {
        const datasetId: string = args['datasetId'] as string;
        const content = new Widget();
        content.addClass('vrefs-main-content');
        const root = createRoot(content.node);
        root.render(
          <DatasetDetailPanel
            service={service}
            datasetId={datasetId}
            onBack={() => app.commands.execute('vrefs:open-catalogue')}
            onOpenWorkflow={() => { }}
          />
        );
        const main = new MainAreaWidget({ content });
        main.title.label = `Dataset: ${datasetId}`;
        main.title.icon = vreFSIcon;
        main.title.closable = true;
        app.shell.add(main, 'main');
        app.shell.activateById(main.id);
      }
    });

    // -----------------------------------------------------------------------
    // Command: picker mode — called by the workflow manager extension.
    // Opens the catalogue in a main area tab. When the user selects a dataset
    // the chosen PID is passed back via the 'vrefs:dataset-picked' command.
    //
    // Usage from the workflow manager:
    //   app.commands.execute('vrefs:pick-dataset', {
    //     callbackCommand: 'my-extension:receive-dataset'
    //   });
    //
    // vreFS will then call:
    //   app.commands.execute('my-extension:receive-dataset', { pid, name });
    // -----------------------------------------------------------------------
    app.commands.addCommand('vrefs:pick-dataset', {
      label: 'vreFS: Pick Dataset for Workflow',
      execute: (args: any) => {
        const callbackCommand: string = (args['callbackCommand'] as string) ?? '';
        const content = new Widget();
        content.addClass('vrefs-main-content');
        const root = createRoot(content.node);

        let mainWidget: MainAreaWidget<Widget>;

        root.render(
          <DataLakePanel
            service={service}
            onPickDataset={(pid: string, name: string) => {
              // Fire the caller's callback command with the chosen dataset
              if (callbackCommand) {
                app.commands.execute(callbackCommand, { pid, name });
              }
              // Close this picker tab
              mainWidget?.close();
            }}
          />
        );

        mainWidget = new MainAreaWidget({ content });
        mainWidget.title.label = 'Select dataset';
        mainWidget.title.icon = vreFSIcon;
        mainWidget.title.closable = true;
        app.shell.add(mainWidget, 'main');
        app.shell.activateById(mainWidget.id);
      }
    });

    // -----------------------------------------------------------------------
    // Register commands in palette
    // -----------------------------------------------------------------------
    if (palette) {
      palette.addItem({ command: 'vrefs:open-catalogue', category: 'vreFS' });
      palette.addItem({ command: 'vrefs:pick-dataset', category: 'vreFS' });
    }

    // Restore sidebar on reload
    if (restorer) {
      restorer.add(sidebar, PANEL_ID);
    }

    console.log('vreFS extension activated');
  }
};

export default plugin;
