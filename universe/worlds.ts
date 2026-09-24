// What each world's surface is made of, as far as it is known: the colours of
// its rock, dust and ice (linear albedo, from spacecraft photometry), its
// clouds and seas, what lies scattered on the ground, and what grows there.
// The real bodies of the Solar System get their own; generated planets follow
// their kind.

import type { PlanetKind } from './mandelbrot';

type RGB = [number, number, number];

/** Surface features the ground shader knows how to draw, on top of the base materials. */
export const FEATURE = {
    regolith: 0,
    /** Mercury: dark, bluish low-reflectance plains, bright young crater rays. */
    mercury: 1,
    /** Io: sulfur in yellow, orange and red, white SO₂ frost, black lava lakes that glow. */
    io: 2,
    /** Europa: bright water ice crossed by reddish-brown lineae, chaos terrain. */
    europa: 3,
    /** Ganymede: dark ancient terrain and bright grooved lanes. */
    ganymede: 4,
    /** Callisto: dark, saturated with craters, bright frost on the rims and peaks. */
    callisto: 5,
    /** Enceladus: fresh snow, the blue "tiger stripe" fractures. */
    enceladus: 6,
    /** Titan: dark hydrocarbon dunes, water-ice pebbles on brighter plains. */
    titan: 7,
    /** Triton: pinkish nitrogen frost, "cantaloupe" terrain, dark plume streaks. */
    triton: 8,
    /** Iapetus: coal-dark on one side, snow-white on the other. */
    iapetus: 9,
    /** Mars: ochre dust, dark basaltic sand in ripples and dunes, layered rock. */
    mars: 10,
    /** Venus: platy basalt under an orange sky, rough tesserae. */
    venus: 11,
    /** The Moon: bright anorthosite highlands, dark basalt maria. */
    moon: 12,
    /** Phobos: dark regolith scored by parallel grooves. */
    phobos: 13,
    /** A young lava world: black crust, molten rock glowing in the lows. */
    lava: 14,
} as const;

export interface SurfaceMaterial {
    /** Bright or high ground (highlands, frost, sulfur…). */
    a: RGB;
    /** Dark or low ground (maria, dunes, old terrain…). */
    b: RGB;
    /** Exposed rock on steep slopes. */
    rock: RGB;
    /** Accents the feature uses: cracks, fresh ejecta, frost, stripes. */
    c: RGB;
    d: RGB;
    feature: number;
    /** 0 glassy … 1 powdery. */
    rough: number;
}

export interface CloudLayer {
    /** Share of the sky covered, 0…1. */
    cover: number;
    /** Base and top of the layer, m. */
    base: number;
    top: number;
    /** Optical thickness: 1 for Earth's cumulus, a tenth for thin ice haze. */
    density: number;
    albedo: RGB;
}

export interface Liquid {
    name: string;
    /** Colour of deep and of shallow liquid, lit. */
    deep: RGB;
    shallow: RGB;
    /** Wave height, m: Titan's methane seas are mirror-still. */
    waves: number;
    /** How fast light is lost with depth, per m (murkier = larger). */
    murk: number;
}

export interface WorldLook {
    material: SurfaceMaterial;
    clouds: CloudLayer | null;
    liquid: Liquid | null;
    /** Grass and forests. */
    flora: boolean;
    /** Boulders lying about: how many (0…1), what they look like and their colour. */
    rocks: { density: number; shape: 'boulder' | 'slab' | 'ice' | 'pebble'; color: RGB };
    /** What is there to gather, as it reads after «собрать» (accusative plural). */
    item: string;
    /** What the ground is really made of, for the info panel. */
    note: string;
}

const WATER: Liquid = { name: 'вода', deep: [0.0, 0.018, 0.04], shallow: [0.02, 0.2, 0.2], waves: 0.6, murk: 0.12 };
const METHANE: Liquid = { name: 'жидкий метан и этан', deep: [0.02, 0.012, 0.005], shallow: [0.08, 0.05, 0.02], waves: 0.03, murk: 0.05 };

const EARTH_CLOUDS: CloudLayer = { cover: 0.45, base: 2300, top: 4800, density: 1, albedo: [1, 1, 1] };

const icy = (a: RGB, b: RGB, item = 'ледяные керны'): WorldLook => ({
    material: { a, b, rock: [b[0] * 0.9, b[1] * 0.9, b[2] * 0.95], c: [Math.min(1, a[0] * 1.15), Math.min(1, a[1] * 1.15), Math.min(1, a[2] * 1.15)], d: b, feature: FEATURE.regolith, rough: 0.55 },
    clouds: null, liquid: null, flora: false,
    rocks: { density: 0.3, shape: 'ice', color: a },
    item,
    note: 'Кора из водяного льда, твёрдого, как гранит при таком холоде; сверху — ледяная пыль, выбитая метеоритами.',
});

const LOOKS: Record<string, WorldLook> = {
    'Земля': {
        material: { a: [0.3, 0.28, 0.22], b: [0.08, 0.1, 0.04], rock: [0.22, 0.2, 0.18], c: [0.64, 0.57, 0.42], d: [0.86, 0.89, 0.93], feature: FEATURE.regolith, rough: 0.9 },
        clouds: EARTH_CLOUDS, liquid: WATER, flora: true,
        rocks: { density: 0.2, shape: 'boulder', color: [0.24, 0.22, 0.2] },
        item: 'редкие минералы',
        note: 'Гранитная и базальтовая кора под почвой; травы и леса, океаны покрывают 71 % поверхности, облака — примерно половину неба.',
    },
    'Луна': {
        material: { a: [0.17, 0.165, 0.155], b: [0.065, 0.063, 0.06], rock: [0.12, 0.118, 0.112], c: [0.27, 0.265, 0.25], d: [0.1, 0.1, 0.1], feature: FEATURE.moon, rough: 0.95 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.55, shape: 'boulder', color: [0.13, 0.128, 0.122] },
        item: 'образцы реголита',
        note: 'Реголит — пыль и обломки: светлые материки из анортозита, тёмные «моря» из застывшего базальта, стеклянные бусинки от ударов метеоритов.',
    },
    'Меркурий': {
        material: { a: [0.13, 0.125, 0.12], b: [0.07, 0.073, 0.08], rock: [0.1, 0.098, 0.095], c: [0.24, 0.235, 0.22], d: [0.05, 0.05, 0.055], feature: FEATURE.mercury, rough: 0.95 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.5, shape: 'boulder', color: [0.1, 0.1, 0.1] },
        item: 'образцы реголита',
        note: 'Тёмный реголит, богатый графитом (отсюда низкая отражательная способность), светлые лучи молодых кратеров; днём до +430 °C, ночью −180 °C.',
    },
    'Марс': {
        material: { a: [0.36, 0.17, 0.07], b: [0.17, 0.09, 0.05], rock: [0.22, 0.12, 0.065], c: [0.45, 0.27, 0.14], d: [0.12, 0.075, 0.055], feature: FEATURE.mars, rough: 0.92 },
        clouds: { cover: 0.22, base: 18_000, top: 21_000, density: 0.1, albedo: [0.95, 0.9, 0.85] },
        liquid: null, flora: false,
        rocks: { density: 0.65, shape: 'boulder', color: [0.16, 0.1, 0.07] },
        item: 'образцы грунта',
        note: 'Базальт, покрытый пылью оксидов железа (ржавчина — отсюда цвет); тёмные дюны из базальтового песка, слоистые осадочные породы, редкие облака из водяного льда.',
    },
    'Венера': {
        material: { a: [0.2, 0.15, 0.1], b: [0.09, 0.08, 0.07], rock: [0.14, 0.11, 0.08], c: [0.16, 0.13, 0.1], d: [0.07, 0.06, 0.05], feature: FEATURE.venus, rough: 0.85 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.8, shape: 'slab', color: [0.12, 0.1, 0.08] },
        item: 'базальтовые образцы',
        note: 'Плитчатый базальт, как на снимках «Венеры-13»; +465 °C и 92 бар, облака серной кислоты на высоте 45–70 км дают ровный оранжевый свет.',
    },
    'Фобос': {
        material: { a: [0.075, 0.07, 0.065], b: [0.05, 0.047, 0.045], rock: [0.06, 0.057, 0.054], c: [0.04, 0.038, 0.036], d: [0.09, 0.085, 0.08], feature: FEATURE.phobos, rough: 0.97 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.35, shape: 'boulder', color: [0.06, 0.057, 0.054] },
        item: 'образцы реголита',
        note: 'Один из самых тёмных объектов Солнечной системы: углистый реголит, параллельные борозды — следы приливных сил Марса или выбросов из кратера Стикни.',
    },
    'Деймос': {
        material: { a: [0.08, 0.075, 0.07], b: [0.06, 0.056, 0.052], rock: [0.07, 0.066, 0.062], c: [0.1, 0.095, 0.09], d: [0.05, 0.05, 0.05], feature: FEATURE.regolith, rough: 0.97 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.25, shape: 'boulder', color: [0.07, 0.066, 0.062] },
        item: 'образцы реголита',
        note: 'Тёмный углистый реголит, настолько толстый, что сгладил почти все кратеры.',
    },
    'Ио': {
        material: { a: [0.62, 0.52, 0.14], b: [0.5, 0.24, 0.06], rock: [0.3, 0.25, 0.12], c: [0.8, 0.8, 0.72], d: [0.02, 0.018, 0.015], feature: FEATURE.io, rough: 0.8 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.25, shape: 'boulder', color: [0.3, 0.22, 0.08] },
        item: 'кристаллы серы',
        note: 'Самый вулканический мир: сера (жёлтая, оранжевая, красная), белый иней диоксида серы, чёрные озёра силикатной лавы — они светятся.',
    },
    'Европа': {
        material: { a: [0.7, 0.68, 0.64], b: [0.55, 0.5, 0.45], rock: [0.5, 0.48, 0.46], c: [0.35, 0.18, 0.09], d: [0.45, 0.33, 0.24], feature: FEATURE.europa, rough: 0.5 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.2, shape: 'ice', color: [0.62, 0.6, 0.58] },
        item: 'пробы льда',
        note: 'Молодой гладкий лёд над подлёдным океаном; красно-бурые линеи — трещины, заполненные солями из океана; «хаос» — взломанный и замёрзший вновь лёд.',
    },
    'Ганимед': {
        material: { a: [0.45, 0.43, 0.4], b: [0.18, 0.15, 0.12], rock: [0.3, 0.28, 0.26], c: [0.7, 0.7, 0.72], d: [0.25, 0.22, 0.2], feature: FEATURE.ganymede, rough: 0.7 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.3, shape: 'ice', color: [0.35, 0.33, 0.31] },
        item: 'пробы льда',
        note: 'Древние тёмные области с кратерами и светлые борозды молодого льда; под корой — солёный океан.',
    },
    'Каллисто': {
        material: { a: [0.2, 0.17, 0.14], b: [0.12, 0.1, 0.085], rock: [0.16, 0.14, 0.12], c: [0.65, 0.65, 0.68], d: [0.1, 0.09, 0.08], feature: FEATURE.callisto, rough: 0.9 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.45, shape: 'boulder', color: [0.14, 0.12, 0.1] },
        item: 'пробы льда',
        note: 'Самая изрытая кратерами поверхность Солнечной системы: тёмная пыль на льду, яркий иней на вершинах и валах кратеров.',
    },
    'Энцелад': {
        material: { a: [0.95, 0.96, 0.98], b: [0.85, 0.88, 0.92], rock: [0.75, 0.8, 0.86], c: [0.35, 0.55, 0.75], d: [0.6, 0.75, 0.9], feature: FEATURE.enceladus, rough: 0.4 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.2, shape: 'ice', color: [0.9, 0.92, 0.95] },
        item: 'ледяные кристаллы',
        note: 'Самая белая поверхность Солнечной системы — свежий снег из гейзеров; голубые «тигровые полосы» — тёплые трещины над подлёдным океаном.',
    },
    'Титан': {
        material: { a: [0.3, 0.2, 0.1], b: [0.12, 0.08, 0.05], rock: [0.35, 0.3, 0.25], c: [0.4, 0.3, 0.18], d: [0.16, 0.11, 0.06], feature: FEATURE.titan, rough: 0.85 },
        clouds: { cover: 0.18, base: 25_000, top: 30_000, density: 0.35, albedo: [0.9, 0.7, 0.45] },
        liquid: METHANE, flora: false,
        rocks: { density: 0.5, shape: 'pebble', color: [0.4, 0.33, 0.25] },
        item: 'пробы толинов',
        note: 'Дюны из тёмных органических песчинок (толинов), окатанная галька из водяного льда, озёра жидкого метана и этана под оранжевой дымкой; −179 °C, 1,5 бар.',
    },
    'Тритон': {
        material: { a: [0.8, 0.68, 0.62], b: [0.55, 0.5, 0.45], rock: [0.6, 0.58, 0.55], c: [0.2, 0.17, 0.15], d: [0.9, 0.85, 0.82], feature: FEATURE.triton, rough: 0.6 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.2, shape: 'ice', color: [0.7, 0.62, 0.58] },
        item: 'пробы азотного льда',
        note: 'Розоватый иней из азота и метана, «дынная корка» — ячеистый рельеф, тёмные полосы от азотных гейзеров; −235 °C.',
    },
    'Япет': {
        material: { a: [0.6, 0.6, 0.58], b: [0.05, 0.035, 0.025], rock: [0.3, 0.28, 0.26], c: [0.7, 0.7, 0.68], d: [0.04, 0.03, 0.02], feature: FEATURE.iapetus, rough: 0.8 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.3, shape: 'ice', color: [0.4, 0.39, 0.37] },
        item: 'пробы тёмного вещества',
        note: 'Двуликий: одно полушарие чёрное, как уголь (пыль с Фебы), другое — белое, как снег.',
    },
    'Миранда': {
        material: { a: [0.35, 0.35, 0.36], b: [0.25, 0.25, 0.26], rock: [0.3, 0.3, 0.32], c: [0.5, 0.5, 0.52], d: [0.2, 0.2, 0.21], feature: FEATURE.ganymede, rough: 0.7 },
        clouds: null, liquid: null, flora: false,
        rocks: { density: 0.35, shape: 'ice', color: [0.32, 0.32, 0.33] },
        item: 'ледяные керны',
        note: 'Лоскутная поверхность: венцы из борозд и обрывы высотой до 20 км (уступ Верона — самый высокий в Солнечной системе).',
    },
    'Умбриэль': icy([0.13, 0.13, 0.13], [0.09, 0.09, 0.09]),
    'Ариэль': icy([0.4, 0.39, 0.38], [0.3, 0.29, 0.28]),
    'Титания': icy([0.3, 0.29, 0.28], [0.22, 0.21, 0.2]),
    'Оберон': icy([0.25, 0.24, 0.23], [0.16, 0.15, 0.14]),
    'Мимас': icy([0.75, 0.75, 0.75], [0.6, 0.6, 0.62]),
    'Тефия': icy([0.85, 0.85, 0.86], [0.7, 0.7, 0.72]),
    'Диона': icy([0.75, 0.75, 0.76], [0.55, 0.55, 0.57]),
    'Рея': icy([0.7, 0.7, 0.7], [0.5, 0.5, 0.52]),
};

/** Looks for generated worlds, by kind. */
function byKind(kind: PlanetKind | 'moon'): WorldLook {
    switch (kind) {
        case 'earth': return LOOKS['Земля'];
        case 'desert': return LOOKS['Марс'];
        case 'venus': return LOOKS['Венера'];
        case 'ice': return { ...LOOKS['Европа'], note: 'Ледяная кора; трещины, заполненные солями, выдают океан под ней.' };
        case 'lava': return {
            material: { a: [0.07, 0.06, 0.055], b: [0.03, 0.028, 0.026], rock: [0.05, 0.045, 0.04], c: [0.16, 0.13, 0.11], d: [1, 0.3, 0.05], feature: FEATURE.lava, rough: 0.8 },
            clouds: null, liquid: null, flora: false,
            rocks: { density: 0.5, shape: 'boulder', color: [0.05, 0.045, 0.04] },
            item: 'образцы обсидиана',
            note: 'Молодая базальтовая корка над океаном магмы; в трещинах и низинах светится расплав.',
        };
        default: return LOOKS['Луна'];
    }
}

export function worldLook(name: string, kind: PlanetKind | 'moon'): WorldLook {
    // Generated planets are named after their star: «PTK 12345 b».
    return LOOKS[name] ?? byKind(kind);
}

/** Relief amplitude and craters for the real bodies whose landscapes are known. */
export const RELIEF: Record<string, { relief: number; craters: boolean }> = {
    'Меркурий': { relief: 3000, craters: true },
    'Луна': { relief: 2500, craters: true },
    'Фобос': { relief: 900, craters: true },
    'Деймос': { relief: 400, craters: true },
    'Ио': { relief: 2600, craters: false },
    'Европа': { relief: 250, craters: false },
    'Ганимед': { relief: 1500, craters: true },
    'Каллисто': { relief: 1800, craters: true },
    'Энцелад': { relief: 700, craters: true },
    'Тритон': { relief: 400, craters: false },
    'Япет': { relief: 4000, craters: true },
    'Мимас': { relief: 3000, craters: true },
    'Миранда': { relief: 5000, craters: false },
};
