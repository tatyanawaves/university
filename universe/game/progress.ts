// The pilot's progress: score (spent on upgrades), upgrades, the look of the
// ship, mission logs, what each creature remembers, and where in the universe
// the pilot is. Kept in this browser's localStorage and saved as the game goes.

import type { LevelRequest } from '../common';
import type { Mission } from './missions';

export type UpgradeId = 'turbo' | 'hull' | 'shield' | 'regen' | 'damage' | 'rate';

export interface UpgradeDef {
    id: UpgradeId;
    title: string;
    icon: string;
    /** What each level gives, for the shop. */
    effect: (level: number) => string;
    /** Price of the next level, by current level. */
    cost: number[];
}

export const UPGRADES: UpgradeDef[] = [
    { id: 'turbo', title: 'Турбо-ускорение', icon: '🚀', effect: l => `форсаж ×${10 + 10 * l}`, cost: [300, 800, 1600] },
    { id: 'hull', title: 'Усиленный корпус', icon: '🛡', effect: l => `корпус ${100 + 50 * l}`, cost: [250, 700, 1400] },
    { id: 'shield', title: 'Мощный щит', icon: '🔷', effect: l => `щит ${100 + 50 * l}`, cost: [250, 700, 1400] },
    { id: 'regen', title: 'Быстрая перезарядка щита', icon: '♻️', effect: l => `${10 + 8 * l} ед./с`, cost: [200, 500, 1000] },
    { id: 'damage', title: 'Плазменные заряды', icon: '💥', effect: l => `урон ×${(1 + 0.3 * l).toFixed(1)}`, cost: [350, 900, 1800] },
    { id: 'rate', title: 'Скорострельность', icon: '⚡', effect: l => `${Math.round(1 / (0.12 * (1 - 0.15 * l)))} выстр./с`, cost: [300, 800, 1600] },
];
export const MAX_LEVEL = 3;

export type ShipVariant = 'classic' | 'delta' | 'heavy';
export interface ShipLook { hull: string; accent: string; glow: string; variant: ShipVariant }
export const DEFAULT_LOOK: ShipLook = { hull: '#8a929e', accent: '#5c6573', glow: '#4aa8ff', variant: 'classic' };

/** What a creature remembers of the pilot. */
export interface CreatureMemory {
    talks: number;
    /** −3 (hurt) … +3 (fond), moved by the tone of the pilot's replies and by errands done. */
    mood: number;
    /** The last few things the pilot said. */
    said: string[];
    /** Errands it gave, and how they went. */
    errands: { title: string; state: 'active' | 'done' | 'failed' }[];
    /** Stories it has already told the pilot, so it tells new ones next time. */
    told?: string[];
    /** Its name, so the others can talk about it. */
    name?: string;
}

/**
 * What the whole world knows, shared by every creature: what the pilot has done, every line
 * any creature has said to the pilot (none is said twice), and the order of every talk so far
 * (none is used twice).
 */
export interface WorldMemory {
    told: string[];
    orders: string[];
    deeds: { text: string; at: number }[];
    kills: Record<string, number>;
}

/** Beyond these, the oldest are forgotten (the save stays small). */
const WORLD_TOLD = 800, WORLD_ORDERS = 2000, WORLD_DEEDS = 40;

export function freshWorld(): WorldMemory {
    return { told: [], orders: [], deeds: [], kills: {} };
}

/** Everything a creature knows before it speaks: the world's memory and the others' memories. */
export interface SharedMemory {
    world: WorldMemory;
    creatures: Record<string, CreatureMemory>;
}

/** A line or an order now said: the world will not hear it again. */
export function rememberTold(w: WorldMemory, line: string) {
    if (!w.told.includes(line)) w.told = [...w.told, line].slice(-WORLD_TOLD);
}

export function rememberOrder(w: WorldMemory, order: string) {
    if (!w.orders.includes(order)) w.orders = [...w.orders, order].slice(-WORLD_ORDERS);
}

export function rememberDeed(w: WorldMemory, text: string, at = Date.now()) {
    w.deeds = [...w.deeds, { text, at }].slice(-WORLD_DEEDS);
}

export interface SavedLog { missions: Mission[]; activeId: string | null }

export interface SaveData {
    v: 1;
    score: number;
    hull: number;
    shield: number;
    upgrades: Record<UpgradeId, number>;
    look: ShipLook;
    logs: Record<string, SavedLog>;
    creatures: Record<string, CreatureMemory>;
    path: LevelRequest[] | null;
    stats: { kills: number; errands: number; seconds: number };
    savedAt: number;
    /** How far along the locals' buildings are (0…1), by planet and builder. */
    builds?: Record<string, number>;
    /** What all the creatures know together. */
    world?: WorldMemory;
}

const KEY = 'university_save_v1';

function fresh(): SaveData {
    return {
        v: 1, score: 0, hull: 100, shield: 100,
        upgrades: { turbo: 0, hull: 0, shield: 0, regen: 0, damage: 0, rate: 0 },
        look: { ...DEFAULT_LOOK }, logs: {}, creatures: {}, path: null,
        stats: { kills: 0, errands: 0, seconds: 0 }, savedAt: 0,
    };
}

function read(): SaveData {
    try {
        const raw = localStorage.getItem(KEY);
        if (!raw) return fresh();
        const d = JSON.parse(raw) as Partial<SaveData>;
        const base = fresh();
        return {
            ...base, ...d,
            upgrades: { ...base.upgrades, ...(d.upgrades ?? {}) },
            look: { ...base.look, ...(d.look ?? {}) },
            stats: { ...base.stats, ...(d.stats ?? {}) },
            logs: d.logs ?? {}, creatures: d.creatures ?? {},
        };
    } catch {
        return fresh(); // no storage (private mode) or a broken save: start afresh
    }
}

type Listener = () => void;

class Progress {
    data: SaveData = read();
    /** True if a saved game was found at start. */
    readonly hadSave = this.data.savedAt > 0;
    private listeners = new Set<Listener>();

    onChange(fn: Listener): () => void {
        this.listeners.add(fn);
        return () => this.listeners.delete(fn);
    }

    changed() { for (const fn of this.listeners) fn(); }

    save() {
        this.data.savedAt = Date.now();
        try { localStorage.setItem(KEY, JSON.stringify(this.data)); } catch { /* storage full or blocked */ }
    }

    reset() {
        try { localStorage.removeItem(KEY); } catch { /* nothing to remove */ }
        this.data = fresh();
        this.changed();
    }

    level(id: UpgradeId): number { return this.data.upgrades[id] ?? 0; }

    nextCost(id: UpgradeId): number | null {
        const def = UPGRADES.find(u => u.id === id)!;
        const l = this.level(id);
        return l >= MAX_LEVEL ? null : def.cost[l];
    }

    /** Spend score on the next level of an upgrade; false if it cannot be afforded or is maxed. */
    buy(id: UpgradeId): boolean {
        const cost = this.nextCost(id);
        if (cost === null || this.data.score < cost) return false;
        this.data.score -= cost;
        this.data.upgrades[id] = this.level(id) + 1;
        this.save();
        this.changed();
        return true;
    }

    setLook(look: Partial<ShipLook>) {
        this.data.look = { ...this.data.look, ...look };
        this.save();
        this.changed();
    }

    memory(id: string): CreatureMemory {
        return (this.data.creatures[id] ??= { talks: 0, mood: 0, said: [], errands: [] });
    }

    /** What the creatures know together. */
    shared(): SharedMemory {
        const w = (this.data.world ??= freshWorld());
        w.kills ??= {};
        return { world: w, creatures: this.data.creatures };
    }

    /** Something the pilot did, for the creatures to hear of. */
    deed(text: string) {
        rememberDeed(this.shared().world, text);
    }

    /** An enemy destroyed: the creatures count them. */
    kill(kind: string) {
        const k = this.shared().world.kills;
        k[kind] = (k[kind] ?? 0) + 1;
    }
}

export const progress = new Progress();

/** What the upgrades do, read by the flight and combat code. */
export const effects = {
    get boost() { return 10 + 10 * progress.level('turbo'); },
    get maxHull() { return 100 + 50 * progress.level('hull'); },
    get maxShield() { return 100 + 50 * progress.level('shield'); },
    get regen() { return 10 + 8 * progress.level('regen'); },
    get damage() { return 1 + 0.3 * progress.level('damage'); },
    get fireInterval() { return 0.12 * (1 - 0.15 * progress.level('rate')); },
};
