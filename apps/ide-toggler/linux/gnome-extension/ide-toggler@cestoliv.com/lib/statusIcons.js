// Status icons drawn with Cairo via St.DrawingArea + Clutter animation.
// gi-bound (St/Clutter/Cairo) — NOT loaded by the Node test suite.
//
// Cairo is a GJS built-in bound lazily at enable() time; extension.js calls
// setCairo(imports.cairo) before any icon is built.

import St from 'gi://St';
import Clutter from 'gi://Clutter';

// Palette (mirrors macOS StatusIcon.swift Palette).
export const PALETTE = {
    terracotta:   [224 / 255, 135 / 255,  99 / 255], // #E08763
    terracottaHi: [240 / 255, 164 / 255, 136 / 255], // #F0A488
    cream:        [245 / 255, 238 / 255, 230 / 255], // #F5EEE6
    idleRing:     [225 / 255, 230 / 255, 240 / 255], // slate
};

let Cairo = null;
export function setCairo(c) {
    Cairo = c;
}

// Build a looping Clutter.PropertyTransition. Uses set_from/set_to (GJS auto-boxes
// the JS numbers into the property's GValue type), an infinite repeat_count, and an
// explicit progress mode. Robust: no onComplete-restart, no notify::mapped timing.
export function loopingTransition(propertyName, from, to, durationMs, mode, delayMs = 0) {
    const t = new Clutter.PropertyTransition({property_name: propertyName});
    t.set_from(from);
    t.set_to(to);
    t.set_duration(durationMs);
    t.set_progress_mode(mode);
    t.set_repeat_count(-1);     // loop forever
    if (delayMs)
        t.set_delay(delayMs);
    return t;
}

// Shared outer-radius factor so idle/working/needs all read as the same size
// within the 14px frame (the working spinner's outer diameter must not exceed
// the idle ring's). Center-line radius of a stroked ring at this factor leaves
// the outer edge at (size/2) * RING_OUTER for all three.
const RING_OUTER = 0.76;

// NEEDS: solid radial terracotta dot (~0.56x) + two pulsing ping rings.
// The ping rings loop forever via PropertyTransitions on scale-x/scale-y/opacity,
// added at construction; the second ring is delayed half a cycle.
function makeNeedsIcon(size) {
    const container = new St.Widget({
        width: size,
        height: size,
        // St derives preferred size from CSS, not the Clutter width/height — without
        // this the actor reports an unset (~2^32) natural height that blows up layout.
        style: `width: ${size}px; height: ${size}px;`,
        layout_manager: new Clutter.BinLayout(),
    });
    // Let the expanding rings overflow the icon's own footprint.
    container.set_clip_to_allocation(false);

    const PING_MS = 2100;
    const PING_MAX = 2.0; // expand to 2x the base footprint
    const pings = [];
    for (let i = 0; i < 2; i++) {
        const ring = new St.DrawingArea({
            width: size, height: size,
            style: `width: ${size}px; height: ${size}px;`,
        });
        ring.set_pivot_point(0.5, 0.5);
        ring.set_clip_to_allocation(false);
        // Start collapsed + bright so the very first frame is correct even before
        // a transition tick lands.
        ring.set_scale(0.5, 0.5);
        ring.opacity = 235; // clearly visible against the opaque bg
        ring.connect('repaint', area => {
            const cr = area.get_context();
            const [w, h] = area.get_surface_size();
            // Base ring at the shared outer footprint; the pulse scales it
            // 0.5 -> PING_MAX around the center.
            const r = Math.min(w, h) / 2 * RING_OUTER - 1;
            cr.setLineWidth(2.0);
            cr.setSourceRGBA(...PALETTE.terracotta, 1.0);
            cr.arc(w / 2, h / 2, Math.max(0.5, r), 0, 2 * Math.PI);
            cr.stroke();
            cr.$dispose();
        });
        container.add_child(ring);
        pings.push(ring);
    }

    const dotSize = Math.round(size * 0.56);
    const dot = new St.DrawingArea({
        width: size, height: size,
        style: `width: ${size}px; height: ${size}px;`,
    });
    dot.connect('repaint', area => {
        const cr = area.get_context();
        const [w, h] = area.get_surface_size();
        const cx = w / 2, cy = h / 2;
        const r = dotSize / 2;
        const grad = new Cairo.RadialGradient(
            cx - r * 0.3, cy - r * 0.4, 0, cx, cy, r);
        grad.addColorStopRGBA(0, ...PALETTE.terracottaHi, 1.0);
        grad.addColorStopRGBA(1, ...PALETTE.terracotta, 1.0);
        cr.setSource(grad);
        cr.arc(cx, cy, r, 0, 2 * Math.PI);
        cr.fill();
        cr.$dispose();
    });
    container.add_child(dot);

    container._animate = () => {
        pings.forEach((ring, i) => {
            const delay = i * (PING_MS / 2); // second ring offset half a cycle
            ring.remove_all_transitions();
            ring.add_transition('ping-scale-x', loopingTransition(
                'scale-x', 0.5, PING_MAX, PING_MS, Clutter.AnimationMode.EASE_OUT_QUAD, delay));
            ring.add_transition('ping-scale-y', loopingTransition(
                'scale-y', 0.5, PING_MAX, PING_MS, Clutter.AnimationMode.EASE_OUT_QUAD, delay));
            ring.add_transition('ping-opacity', loopingTransition(
                'opacity', 235, 0, PING_MS, Clutter.AnimationMode.EASE_OUT_QUAD, delay));
        });
    };
    container._stop = () => {
        for (const ring of pings)
            ring.remove_all_transitions();
    };
    return container;
}

// WORKING: spinning cream arc/ring (~0.95s linear loop). Rotation is a single
// infinite PropertyTransition on rotation-angle-z added at construction time.
function makeWorkingIcon(size) {
    const area = new St.DrawingArea({
        width: size, height: size,
        style: `width: ${size}px; height: ${size}px;`,
    });
    area.set_pivot_point(0.5, 0.5);
    // Slightly thinner stroke; outer edge matched to the idle ring's footprint.
    const lineWidth = Math.max(1.5, size * 0.13);
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const cx = w / 2, cy = h / 2;
        // Outer edge = (size/2)*RING_OUTER, same as the idle ring.
        const r = Math.min(w, h) / 2 * RING_OUTER - lineWidth / 2;
        cr.setLineWidth(lineWidth);
        cr.setLineCap(Cairo.LineCap.ROUND);
        const segments = 60;
        const startA = -Math.PI / 2;
        const sweep = 1.5 * Math.PI; // 270deg arc, alpha ramps toward leading end
        for (let i = 0; i < segments; i++) {
            const t1 = (i + 1) / segments;
            const a0 = startA + sweep * (i / segments);
            const a1 = startA + sweep * t1;
            cr.setSourceRGBA(...PALETTE.cream, 0.1 + 0.85 * t1);
            cr.arc(cx, cy, Math.max(0.5, r), a0, a1 + 0.01);
            cr.stroke();
        }
        cr.$dispose();
    });
    area._animate = () => {
        area.remove_all_transitions();
        area.rotation_angle_z = 0;
        area.add_transition('spin', loopingTransition(
            'rotation-angle-z', 0, 360, 950, Clutter.AnimationMode.LINEAR));
    };
    area._stop = () => area.remove_all_transitions();
    return area;
}

// IDLE / noAgent: thin dim slate ring (~0.76x, opacity ~0.34). Static.
function makeIdleIcon(size) {
    const area = new St.DrawingArea({
        width: size, height: size,
        style: `width: ${size}px; height: ${size}px;`,
    });
    area.connect('repaint', a => {
        const cr = a.get_context();
        const [w, h] = a.get_surface_size();
        const r = Math.min(w, h) / 2 * RING_OUTER - 0.75;
        cr.setLineWidth(1.5);
        cr.setSourceRGBA(...PALETTE.idleRing, 0.34);
        cr.arc(w / 2, h / 2, Math.max(0.5, r), 0, 2 * Math.PI);
        cr.stroke();
        cr.$dispose();
    });
    return area;
}

export function makeStatusIcon(state, size) {
    switch (state) {
    case 'needsAttention': return makeNeedsIcon(size);
    case 'working':        return makeWorkingIcon(size);
    default:               return makeIdleIcon(size);
    }
}
