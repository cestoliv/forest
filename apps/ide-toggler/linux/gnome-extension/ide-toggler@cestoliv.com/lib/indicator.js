// Top-bar indicator (GNOME-only divergence, SPEC §9): re-shows the panel after it
// has been hidden via the footer close button. Only present in Main.panel while
// the panel is hidden. gi-bound — NOT loaded by the Node test suite.

import GObject from 'gi://GObject';
import St from 'gi://St';
import Clutter from 'gi://Clutter';

import * as PanelMenu from 'resource:///org/gnome/shell/ui/panelMenu.js';

export const IdeTogglerIndicator = GObject.registerClass(
class IdeTogglerIndicator extends PanelMenu.Button {
    _init(onActivate) {
        super._init(0.0, 'ide-toggler', true); // dontCreateMenu = true
        this._onActivate = onActivate;
        this.add_child(new St.Icon({
            icon_name: 'focus-windows-symbolic',
            style_class: 'system-status-icon',
        }));
        this.connect('button-press-event', () => {
            if (this._onActivate)
                this._onActivate();
            return Clutter.EVENT_STOP;
        });
        this.connect('touch-event', () => {
            if (this._onActivate)
                this._onActivate();
            return Clutter.EVENT_STOP;
        });
    }
});
