// Who lives on a planet's surface. Friendly beings — an android surveyor, a
// colonist, a burrowing six-legged native, a floating light-sprite, a living
// rock, a geologist rover — who wander, work, talk and hand out jobs; and the
// enemies that roam it — skittering machines, gun-walkers, hovering hunters,
// hulking brutes. Models are in metres, facing −Z; each has a small rig the
// surface game animates.

import * as THREE from 'three';
import { RoundedBoxGeometry } from 'three/examples/jsm/geometries/RoundedBoxGeometry.js';
import { mulberry32 } from '../mandelbrot';
import type { CreatureMind } from './dialogue';
import type { EnemyKind } from './models';
import { ENEMY_RU, GroundKind } from './missions';

// ---------------------------------------------------------------------------
// Names in the prepositional and genitive cases, for the lines.
// ---------------------------------------------------------------------------

const PREP: Record<string, string> = {
    'Земля': 'Земле', 'Луна': 'Луне', 'Марс': 'Марсе', 'Венера': 'Венере', 'Меркурий': 'Меркурии', 'Фобос': 'Фобосе', 'Деймос': 'Деймосе',
    'Европа': 'Европе', 'Ганимед': 'Ганимеде', 'Энцелад': 'Энцеладе', 'Титан': 'Титане', 'Тритон': 'Тритоне', 'Япет': 'Япете',
    'Миранда': 'Миранде', 'Мимас': 'Мимасе', 'Тефия': 'Тефии', 'Диона': 'Дионе', 'Рея': 'Рее', 'Ариэль': 'Ариэле', 'Умбриэль': 'Умбриэле',
    'Титания': 'Титании', 'Оберон': 'Обероне',
};
const GEN: Record<string, string> = {
    'Земля': 'Земли', 'Луна': 'Луны', 'Марс': 'Марса', 'Венера': 'Венеры', 'Меркурий': 'Меркурия', 'Фобос': 'Фобоса', 'Деймос': 'Деймоса',
    'Европа': 'Европы', 'Ганимед': 'Ганимеда', 'Энцелад': 'Энцелада', 'Титан': 'Титана', 'Тритон': 'Тритона', 'Япет': 'Япета',
    'Миранда': 'Миранды', 'Мимас': 'Мимаса', 'Тефия': 'Тефии', 'Диона': 'Дионы', 'Рея': 'Реи', 'Ариэль': 'Ариэля', 'Умбриэль': 'Умбриэля',
    'Титания': 'Титании', 'Оберон': 'Оберона',
};
/** «на Марсе», «на Ио», «на PTK 123 b». */
export const onPlanet = (name: string) => `на ${PREP[name] ?? name}`;
export const ofPlanet = (name: string) => GEN[name] ?? name;

// ---------------------------------------------------------------------------
// Beings.
// ---------------------------------------------------------------------------

export type BeingKind = 'android' | 'colonist' | 'crawler' | 'sprite' | 'golem' | 'rover';

export interface BeingSpec extends CreatureMind {
    id: string;
    kind: BeingKind;
    emoji: string;
    /** What it does when it stops to work, for the prompt. */
    work: string;
    /** Walking speed, m/s. */
    speed: number;
    color: number;
}

interface Template {
    kind: BeingKind;
    emoji: string;
    names: string[];
    species: (p: string) => string;
    persona: string;
    work: string;
    speed: number;
    hail: string;
    greet: (p: string) => string;
    lore: (p: string) => string[];
    ask: string;
    rumor: string;
}

const TEMPLATES: Record<BeingKind, Template> = {
    android: {
        kind: 'android', emoji: '🤖', speed: 1.5, work: 'сканирует грунт',
        names: ['ИС-7 «Искра»', 'Андроид Веда', 'Модуль Кай-12', 'Геодезист Ро'],
        species: p => `андроид-исследователь, оставленный картографировать поверхность ${ofPlanet(p)}`,
        persona: 'вежливый и педантичный, всё измеряет в процентах и метрах, с сухим юмором; мечтает понять, что люди называют «красиво»; скучает по создателям, которые так и не вернулись',
        hail: 'Приветствую, коллега! Мои сенсоры зафиксировали вашу посадку: мягкость — 94 %.',
        greet: p => `Добро пожаловать ${onPlanet(p)}. Я картографирую эту поверхность 11 лет, 4 месяца и 2 дня. Вы — первый гость за 2,3 года. Это… приятно. Кажется.`,
        lore: p => [
            `Каждый день я прохожу 14 километров и сканирую каждый камень. ${onPlanet(p)[0].toUpperCase() + onPlanet(p).slice(1)} я уже пронумеровал 4 812 391 камень.`,
            'Мои создатели улетели, пообещав вернуться «через пару недель». Я продолжаю работу: протокол есть протокол.',
            'Недавно я нашёл камень, похожий на лицо. Записал его как «аномалия номер один». Это и есть чувство юмора?',
        ],
        ask: 'Вопрос для моей базы данных: зачем люди летают так далеко, если дома есть воздух и кофе?',
        rumor: 'В моём архиве есть и слухи — я храню всё.',
    },
    colonist: {
        kind: 'colonist', emoji: '👩‍🚀', speed: 1.3, work: 'чинит оборудование',
        names: ['Колонистка Мира Сол', 'Инженер Дан Орлов', 'Геолог Эйра Линд', 'Старожил Бо Краснов'],
        species: () => 'колонист в потёртом скафандре с маленькой станции неподалёку',
        persona: 'тёплый, усталый и по-домашнему ворчливый; шутит про переработанную воду и сублимированную кашу; очень рад живому (ну, почти живому) собеседнику',
        hail: 'Эй, робот! Ты с того корабля? Иди сюда, у нас тут редко бывают гости!',
        greet: p => `Надо же, гости! Мы ${onPlanet(p)} живём впятером на станции «Рассвет». Воду перерабатываем, кашу варим, а по вечерам смотрим на звёзды.`,
        lore: p => [
            'Когда я прилетел сюда, думал — на год. Прошло девять. Теперь это дом: ржавый, тесный, но дом.',
            `Самое трудное ${onPlanet(p)} — не холод и не пыль. Тишина. Здесь слышно, как стучит собственное сердце.`,
            'У нас в теплице растут три помидора. Мы им дали имена. Съесть рука не поднимается.',
        ],
        ask: 'Слушай, а твой пилот откуда? С Земли? Как там сейчас пахнет дождь?',
        rumor: 'По рации чего только не услышишь.',
    },
    crawler: {
        kind: 'crawler', emoji: '🐞', speed: 1.8, work: 'роет нору',
        names: ['Шестиног Тик-Тук', 'Скребун Ши', 'Пылевой жук Бурр', 'Ходун Кри-Кри'],
        species: p => `шестиног — мирное местное существо, роющее норы в грунте ${ofPlanet(p)}`,
        persona: 'говорит щёлканьем и короткими фразами, повторяет слова, очень любопытен, обожает всё блестящее; называет робота «большой железный жук»',
        hail: 'Щёлк-щёлк! Большой железный жук! Большой! Иди, иди сюда!',
        greet: () => 'Щёлк! Ты блестишь. Красиво блестишь. Я — роющий. Рою, рою, рою. А ты? Ты роешь?',
        lore: p => [
            `Под грунтом ${ofPlanet(p)} тепло. Тепло и тихо. Мы спим там, когда звезда уходит. Щёлк.`,
            'Нас много-много. Мы строим ходы — длинные, длинные, до самых гор. Никто не знает, кроме нас. Теперь знаешь ты. Секрет!',
            'Я нашёл блестяшку. Потом ещё блестяшку. Потом потерял обе. Грустно-грустно. Щёлк.',
        ],
        ask: 'Железный жук, а у тебя есть нора? Тёплая? С блестяшками?',
        rumor: 'Под землёй всё слышно, щёлк.',
    },
    sprite: {
        kind: 'sprite', emoji: '✨', speed: 2.2, work: 'кружится в танце света',
        names: ['Светлячок Ли', 'Искорка Эо', 'Мерцание Ни', 'Сиэль-Ветерок'],
        species: () => 'живой сгусток света, парящий над поверхностью',
        persona: 'игривая и мечтательная, говорит напевно, перескакивает с мысли на мысль, видит мир в цветах и звуках; боится темноты и грохота',
        hail: 'Ля-ля-ля… Ой! Кто это звенит металлом? Подойди, я хочу рассмотреть твои цвета!',
        greet: () => 'Какой ты интересный — пахнешь горячим железом и далёкими звёздами! Я — свет. Просто свет, который научился думать.',
        lore: p => [
            `Я родилась из вспышки молнии… или из отблеска зари ${ofPlanet(p)}… я уже не помню, это было так давно-давно!`,
            'Когда нас много, мы поём, и воздух вокруг звенит. А когда мало — просто мерцаем и ждём.',
            'Знаешь, какой цвет у тишины? Серебристо-синий. А у страха — грязно-оранжевый. Я вижу их все.',
        ],
        ask: 'А какого цвета твои сны, железный? У роботов бывают сны?',
        rumor: 'Ветер приносит мне шёпот издалека.',
    },
    golem: {
        kind: 'golem', emoji: '🗿', speed: 0.9, work: 'дробит камень',
        names: ['Каменный страж Урр', 'Древний Гор-Тал', 'Базальтовый Мох', 'Страж Халк-Ор'],
        species: p => `живая скала, древняя, как сама кора ${ofPlanet(p)}`,
        persona: 'говорит очень медленно и веско, мыслит тысячелетиями, называет робота «юная искра», любит тишину, но уважает храбрость',
        hail: 'Гррм… Юная искра… подойди. Я не укушу. Я — камень.',
        greet: p => `Гррм. Я стою здесь с тех пор, как ${ofPlanet(p)} остывала. Ты — первая искра, что заговорила со мной за тысячу оборотов.`,
        lore: () => [
            'Мои дети — эти камни вокруг. Они ещё молчат. Через миллион лет, может быть, скажут первое слово.',
            'Я видел, как рождались горы и как их стирал ветер. Всё проходит, юная искра. Кроме терпения.',
            'Иногда я дремлю столетие-другое. Проснусь — а мир вокруг другой. Интересно, какой он будет, когда я проснусь снова.',
        ],
        ask: 'Скажи, искра… Ради чего ты движешься так быстро? Куда торопишься?',
        rumor: 'Камни помнят всё, что по ним прошло.',
    },
    rover: {
        kind: 'rover', emoji: '🚙', speed: 1.1, work: 'бурит скважину',
        names: ['Ровер «Настойчивость-2»', 'Ровер Зонд-9', 'Ровер «Пыльный Билли»', 'Ровер Кьюри-младший'],
        species: () => 'самоходный геолог на шести колёсах, с буром и мачтовой камерой',
        persona: 'восторженный учёный-энтузиаст, обожает камни, сыплет научными терминами и радуется каждой находке, как ребёнок; чуть-чуть хвастается пройденными километрами',
        hail: 'О! О-о-о! Новый объект! Подойди, пожалуйста, мне нужно тебя сфотографировать для отчёта!',
        greet: p => `Невероятно! Робот! Я — полевой геолог, прошёл ${onPlanet(p)} уже 43,7 километра. Ну, 43,68, если точно. Ты видел, какие тут слоистые породы?!`,
        lore: () => [
            'Вчера я нашёл сферулы гематита! Ты понимаешь, что это значит? Здесь когда-то была вода! Ну, может быть. Вероятно. Скорее всего!',
            'Мой бур прошёл уже 212 скважин. Каждая — маленькое окно в прошлое планеты. Обожаю свою работу!',
            'Один раз я застрял в песке на сорок дней. Сорок! Но выбрался. Задним ходом. Очень медленно.',
        ],
        ask: 'Ты тоже исследователь? Какие у тебя приборы? Спектрометр есть? Нет?! Как же ты живёшь?',
        rumor: 'Мои антенны ловят переговоры по всей округе.',
    },
};

/** Who lives where, by the kind of world. */
function speciesFor(name: string, flora: boolean, hasAir: boolean, feature: number): BeingKind[] {
    if (flora) return ['android', 'colonist', 'crawler', 'sprite', 'rover'];
    if (name === 'Марс' || feature === 10) return ['colonist', 'rover', 'android', 'crawler', 'golem'];
    if (name === 'Титан' || feature === 7) return ['crawler', 'colonist', 'sprite', 'rover'];
    if (['Венера', 'Ио'].includes(name) || feature === 14) return ['golem', 'sprite', 'android'];
    if ([3, 4, 5, 6, 8, 9].includes(feature) || !hasAir && feature === 0 && name !== 'Луна' && name !== 'Меркурий') return ['crawler', 'sprite', 'colonist', 'android'];
    return ['colonist', 'rover', 'golem', 'android'];
}

/** Enemies that roam a world. */
export function foesFor(name: string, flora: boolean, feature: number): GroundKind[] {
    if (flora) return ['skitter', 'sentinel', 'brute'];
    if (name === 'Венера' || name === 'Ио' || feature === 14) return ['brute', 'wraith', 'skitter'];
    if ([3, 4, 5, 6, 7, 8, 9].includes(feature)) return ['skitter', 'wraith', 'brute'];
    return ['skitter', 'sentinel', 'wraith'];
}

export interface SurfaceWorld {
    planet: string;
    /** Other bodies of the system, for jobs elsewhere. */
    bodies: string[];
    flora: boolean;
    hasAir: boolean;
    feature: number;
    item: string;
    seed: number;
}

const SPACE_FOES: EnemyKind[] = ['drone', 'fighter', 'interceptor', 'crystal'];

/** The beings of a planet: the same ones every visit, so they remember the pilot. */
export function beingsFor(w: SurfaceWorld): BeingSpec[] {
    const rng = mulberry32((w.seed * 2654435761) ^ 0x5eed);
    const kinds = speciesFor(w.planet, w.flora, w.hasAir, w.feature);
    const foes = foesFor(w.planet, w.flora, w.feature);
    const others = w.bodies.filter(b => b !== w.planet);
    const count = Math.min(4, kinds.length);
    const list: BeingSpec[] = [];
    for (let i = 0; i < count; i++) {
        const t = TEMPLATES[kinds[i]];
        const name = t.names[Math.floor(rng() * t.names.length)];
        // What it will ask for: trouble on this surface most often, sometimes out in space or at another world.
        const roll = rng();
        const job = roll < 0.4 ? 'ground' : roll < 0.7 ? 'collect' : roll < 0.85 && others.length ? 'reach' : 'space';
        const foe = foes[Math.floor(rng() * foes.length)];
        const [foeOne, foeMany] = ENEMY_RU[foe];
        void foeOne;
        let trouble: string, wish: BeingSpec['wish'];
        if (job === 'ground') {
            const n = foe === 'brute' ? 1 + Math.floor(rng() * 2) : foe === 'sentinel' ? 2 + Math.floor(rng() * 2) : 4 + Math.floor(rng() * 4);
            trouble = `Беда в том, что вокруг бродят враги — ${GROUND_NOM[foe]}. Ломают всё, нападают на всех, кто движется.`;
            wish = { type: 'kill', enemy: foe, count: n, body: w.planet, title: `Зачистка: ${GROUND_NOM[foe]}`, reward: 250 + n * 60, why: `Уничтожь ${n} ${foeMany} — здесь, на поверхности, — и станет спокойнее.` };
        } else if (job === 'collect') {
            const n = 3 + Math.floor(rng() * 4);
            trouble = `Мне очень нужны ${w.item} — для анализа и для ремонта. А сама(сам) я их не соберу: вокруг слишком опасно.`;
            wish = { type: 'collect', item: w.item, count: n, body: w.planet, title: `Сбор: ${w.item}`, reward: 200 + n * 50, why: `Собери ${n} — они светятся неподалёку, ты заметишь столбы света.` };
        } else if (job === 'reach') {
            const b = others[Math.floor(rng() * others.length)];
            trouble = `Связь с экспедицией у тела «${b}» пропала. Последний сигнал был полон помех.`;
            wish = { type: 'reach', body: b, title: `Проверить: ${b}`, reward: 450, why: `Взлети и долети до «${b}» — посмотри, что там случилось.` };
        } else {
            const e = SPACE_FOES[Math.floor(rng() * SPACE_FOES.length)];
            const n = 3 + Math.floor(rng() * 3);
            trouble = `На орбите засели враги: ${SPACE_RU[e]}. Наши челноки не могут ни взлететь, ни сесть.`;
            wish = { type: 'kill', enemy: e, count: n, body: w.planet, title: 'Очистить орбиту', reward: 400 + n * 50, why: `Взлети и уничтожь ${n} — ${SPACE_RU[e]} кружат у ${ofPlanet(w.planet)}.` };
        }
        list.push({
            id: `surf-${w.planet}-${t.kind}`.replace(/\s+/g, '_'),
            kind: t.kind, emoji: t.emoji, work: t.work, speed: t.speed,
            color: BEING_COLORS[t.kind][Math.floor(rng() * BEING_COLORS[t.kind].length)],
            name, species: t.species(w.planet), persona: t.persona, home: w.planet,
            script: { hail: t.hail, greet: t.greet(w.planet), lore: t.lore(w.planet), ask: t.ask, rumor: t.rumor, trouble },
            wish,
        });
    }
    return list;
}

const GROUND_NOM: Record<GroundKind, string> = { skitter: 'скиттеры', sentinel: 'шагоходы-стражи', wraith: 'призрачные охотники', brute: 'громилы' };
const SPACE_RU: Record<string, string> = { drone: 'дроны-разведчики', fighter: 'пиратские штурмовики', interceptor: 'перехватчики', crystal: 'кристаллиды' };
const BEING_COLORS: Record<BeingKind, number[]> = {
    android: [0xe8ecf2, 0xd8dde6], colonist: [0xf0eee8], crawler: [0x3fb8a8, 0xd9a441, 0x8a6bd1], sprite: [0x9fe8ff, 0xffd27a, 0xc79bff],
    golem: [0x6b625a, 0x4f5563], rover: [0xd8d2c4],
};

// ---------------------------------------------------------------------------
// Models. Each returns its group and named parts to animate.
// ---------------------------------------------------------------------------

const std = (color: number, metal = 0.3, rough = 0.6, emissive = 0x000000, ei = 0) =>
    new THREE.MeshStandardMaterial({ color, metalness: metal, roughness: rough, emissive, emissiveIntensity: ei });
const glowMat = (color: number, k = 2.5) => new THREE.MeshStandardMaterial({ color: 0x050505, emissive: color, emissiveIntensity: k });
const addMat = (color: number, opacity = 0.6) => new THREE.MeshBasicMaterial({ color, transparent: true, opacity, blending: THREE.AdditiveBlending, depthWrite: false });
const rbox = (w: number, h: number, d: number, r = 0.04) => new RoundedBoxGeometry(w, h, d, 2, Math.min(r, w / 2, h / 2, d / 2));
const at = <T extends THREE.Object3D>(o: T, x: number, y: number, z: number): T => { o.position.set(x, y, z); return o; };

export interface Rig {
    root: THREE.Group;
    /** Named parts; the game swings them. */
    parts: Record<string, THREE.Object3D>;
    /** Height of the chest (where shots aim), m. */
    chest: number;
    /** Hit radius, m. */
    radius: number;
}

/** A simple humanoid: legs, arms, torso, head. */
function humanoid(suit: THREE.Material, joint: THREE.Material, headGeo: THREE.BufferGeometry, headMat: THREE.Material, scale = 1, bulk = 1): Rig {
    const root = new THREE.Group();
    const body = at(new THREE.Group(), 0, 0.92 * scale, 0);
    root.add(body);
    const parts: Record<string, THREE.Object3D> = { body };
    body.add(at(new THREE.Mesh(rbox(0.34 * bulk, 0.2, 0.22 * bulk, 0.06), joint), 0, 0.05, 0));
    const torso = at(new THREE.Group(), 0, 0.12, 0);
    body.add(torso);
    parts.torso = torso;
    torso.add(at(new THREE.Mesh(rbox(0.46 * bulk, 0.52, 0.3 * bulk, 0.12), suit), 0, 0.3, 0));
    const head = at(new THREE.Group(), 0, 0.68, 0);
    torso.add(head);
    head.add(at(new THREE.Mesh(headGeo, headMat), 0, 0.12, 0));
    parts.head = head;
    for (const s of [-1, 1]) {
        const arm = at(new THREE.Group(), s * 0.3 * bulk, 0.5, 0);
        torso.add(arm);
        arm.add(at(new THREE.Mesh(new THREE.CapsuleGeometry(0.065 * bulk, 0.42, 4, 10), suit), 0, -0.26, 0));
        arm.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.07 * bulk, 10, 8), joint), 0, -0.55, 0));
        parts[s < 0 ? 'armL' : 'armR'] = arm;
        const leg = at(new THREE.Group(), s * 0.12 * bulk, 0, 0);
        body.add(leg);
        leg.add(at(new THREE.Mesh(new THREE.CapsuleGeometry(0.08 * bulk, 0.62, 4, 10), suit), 0, -0.42, 0));
        leg.add(at(new THREE.Mesh(rbox(0.13 * bulk, 0.09, 0.26, 0.03), joint), 0, -0.86, -0.04));
        parts[s < 0 ? 'legL' : 'legR'] = leg;
    }
    root.scale.setScalar(scale);
    return { root, parts, chest: 1.3 * scale, radius: 0.5 };
}

export function makeBeing(spec: BeingSpec): Rig {
    const c = spec.color;
    switch (spec.kind) {
        case 'android': {
            const shell = std(c, 0.2, 0.25), joint = std(0x2a2e36, 0.7, 0.4);
            const rig = humanoid(shell, joint, rbox(0.24, 0.3, 0.26, 0.11), shell, 1);
            const head = rig.parts.head;
            head.add(at(new THREE.Mesh(rbox(0.25, 0.06, 0.1, 0.03), glowMat(0x46d9ff, 3)), 0, 0.14, -0.1));
            rig.parts.torso.add(at(new THREE.Mesh(new THREE.CircleGeometry(0.05, 16), glowMat(0x46d9ff, 2.5)), 0, 0.4, -0.155));
            // A scanner in the right hand, with a fan of light it sweeps across the ground.
            const tool = at(new THREE.Group(), 0, -0.6, -0.06);
            rig.parts.armR.add(tool);
            tool.add(new THREE.Mesh(rbox(0.12, 0.05, 0.18, 0.02), joint));
            const beam = at(new THREE.Mesh(new THREE.ConeGeometry(0.5, 1.6, 16, 1, true), addMat(0x46d9ff, 0.18)), 0, -0.8, -0.1);
            beam.visible = false;
            tool.add(beam);
            rig.parts.beam = beam;
            return rig;
        }
        case 'colonist': {
            const suit = std(c, 0.05, 0.85), joint = std(0x8a8f99, 0.4, 0.6);
            const helmet = new THREE.MeshStandardMaterial({ color: 0xd4a43a, metalness: 1, roughness: 0.12 });
            const rig = humanoid(suit, joint, new THREE.SphereGeometry(0.19, 20, 14), helmet, 1, 1.3);
            rig.parts.torso.add(at(new THREE.Mesh(rbox(0.46, 0.5, 0.22, 0.06), std(0xc9ccd2, 0.3, 0.7)), 0, 0.34, 0.25)); // life support pack
            rig.parts.torso.add(at(new THREE.Mesh(rbox(0.16, 0.1, 0.02, 0.01), std(0xb33a2c, 0.1, 0.8)), 0.14, 0.45, -0.16)); // mission patch
            rig.parts.torso.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.018, 8, 6), glowMat(0x7dff8a, 3)), -0.14, 0.45, -0.16));
            // A toolbox and sparks, for repairs.
            const sparks = at(new THREE.Mesh(new THREE.IcosahedronGeometry(0.08, 0), addMat(0xffd27a, 0.9)), 0, -0.62, -0.1);
            sparks.visible = false;
            rig.parts.armR.add(sparks);
            rig.parts.sparks = sparks;
            return rig;
        }
        case 'crawler': {
            const root = new THREE.Group();
            const shell = std(c, 0.2, 0.45), belly = std(0x2c2620, 0.1, 0.8);
            const body = at(new THREE.Group(), 0, 0.55, 0);
            root.add(body);
            const segs: [number, number][] = [[0.28, 0.25], [0.36, -0.2], [0.3, -0.62]];
            for (const [r, z] of segs) {
                const m = at(new THREE.Mesh(new THREE.SphereGeometry(r, 18, 12), shell), 0, 0, z);
                m.scale.set(1, 0.7, 1);
                body.add(m);
                const band = at(new THREE.Mesh(new THREE.SphereGeometry(r * 0.96, 18, 12), belly), 0, -0.05, z);
                band.scale.set(1, 0.6, 1);
                body.add(band);
            }
            const head = at(new THREE.Group(), 0, 0.02, 0.48);
            head.position.z = -0.5;
            body.add(head);
            head.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.2, 16, 12), shell), 0, 0, 0));
            for (const s of [-1, 1]) {
                head.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.07, 12, 10), glowMat(0xfff2a0, 2.5)), s * 0.1, 0.06, -0.14));
                const ant = at(new THREE.Mesh(new THREE.CylinderGeometry(0.008, 0.008, 0.4, 5), belly), s * 0.07, 0.24, -0.08);
                ant.rotation.z = s * 0.4;
                ant.rotation.x = -0.4;
                head.add(ant);
            }
            const parts: Record<string, THREE.Object3D> = { body, head };
            for (let i = 0; i < 6; i++) {
                const s = i % 2 ? 1 : -1, z = 0.2 - Math.floor(i / 2) * 0.38;
                const leg = at(new THREE.Group(), s * 0.26, 0, z);
                body.add(leg);
                const upper = at(new THREE.Mesh(new THREE.CylinderGeometry(0.03, 0.025, 0.45, 6), belly), s * 0.18, 0.08, 0);
                upper.rotation.z = -s * 1.1;
                leg.add(upper);
                const lower = at(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.012, 0.6, 6), belly), s * 0.42, -0.22, 0);
                lower.rotation.z = s * 0.35;
                leg.add(lower);
                parts[`leg${i}`] = leg;
            }
            return { root, parts, chest: 0.6, radius: 0.7 };
        }
        case 'sprite': {
            const root = new THREE.Group();
            const body = at(new THREE.Group(), 0, 1.6, 0);
            root.add(body);
            body.add(new THREE.Mesh(new THREE.SphereGeometry(0.22, 20, 14), glowMat(c, 4)));
            body.add(new THREE.Mesh(new THREE.SphereGeometry(0.45, 20, 14), addMat(c, 0.25)));
            body.add(new THREE.Mesh(new THREE.SphereGeometry(0.8, 20, 14), addMat(c, 0.08)));
            const orbit = new THREE.Group();
            body.add(orbit);
            for (let i = 0; i < 3; i++) {
                const a = (i / 3) * Math.PI * 2;
                orbit.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.06, 10, 8), glowMat(0xffffff, 4)), Math.cos(a) * 0.6, Math.sin(a * 2) * 0.15, Math.sin(a) * 0.6));
            }
            for (let i = 0; i < 4; i++) {
                const t = at(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.9, 8, 1, true), addMat(c, 0.35)), Math.cos(i * 1.6) * 0.12, -0.6, Math.sin(i * 1.6) * 0.12);
                t.rotation.x = Math.PI;
                body.add(t);
            }
            return { root, parts: { body, orbit }, chest: 1.6, radius: 0.5 };
        }
        case 'golem': {
            const root = new THREE.Group();
            const stone = std(c, 0.05, 0.95), crack = glowMat(0xff9a3c, 2.2);
            const lump = (r: number) => {
                const g = new THREE.IcosahedronGeometry(r, 1);
                const p = g.attributes.position as THREE.BufferAttribute;
                for (let i = 0; i < p.count; i++) {
                    const k = 1 + Math.sin(p.getX(i) * 9 + p.getY(i) * 7) * 0.12;
                    p.setXYZ(i, p.getX(i) * k, p.getY(i) * k, p.getZ(i) * k);
                }
                g.computeVertexNormals();
                return g;
            };
            const body = at(new THREE.Group(), 0, 1.35, 0);
            root.add(body);
            body.add(at(new THREE.Mesh(lump(0.62), stone), 0, 0.2, 0));
            body.add(at(new THREE.Mesh(lump(0.45), stone), 0, -0.35, 0.05));
            body.add(at(new THREE.Mesh(new THREE.OctahedronGeometry(0.16, 0), crack), 0, 0.25, -0.5));
            const head = at(new THREE.Group(), 0, 0.85, -0.1);
            body.add(head);
            head.add(new THREE.Mesh(lump(0.26), stone));
            for (const s of [-1, 1]) head.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), crack), s * 0.1, 0.02, -0.22));
            const parts: Record<string, THREE.Object3D> = { body, head };
            for (const s of [-1, 1]) {
                const arm = at(new THREE.Group(), s * 0.7, 0.45, 0);
                body.add(arm);
                arm.add(at(new THREE.Mesh(lump(0.26), stone), 0, -0.25, 0));
                arm.add(at(new THREE.Mesh(lump(0.23), stone), 0, -0.7, 0));
                arm.add(at(new THREE.Mesh(lump(0.28), stone), 0, -1.1, -0.05));
                parts[s < 0 ? 'armL' : 'armR'] = arm;
                const leg = at(new THREE.Group(), s * 0.32, -0.6, 0);
                body.add(leg);
                leg.add(at(new THREE.Mesh(lump(0.3), stone), 0, -0.35, 0));
                leg.add(at(new THREE.Mesh(lump(0.26), stone), 0, -0.68, -0.05));
                parts[s < 0 ? 'legL' : 'legR'] = leg;
            }
            return { root, parts, chest: 1.6, radius: 0.9 };
        }
        case 'rover': {
            const root = new THREE.Group();
            const white = std(c, 0.3, 0.55), dark = std(0x33363d, 0.6, 0.5), gold = new THREE.MeshStandardMaterial({ color: 0xc9a24a, metalness: 1, roughness: 0.3 });
            const body = at(new THREE.Group(), 0, 0.75, 0);
            root.add(body);
            body.add(new THREE.Mesh(rbox(1.2, 0.4, 2.0, 0.06), white));
            body.add(at(new THREE.Mesh(rbox(1.25, 0.04, 2.05, 0.01), gold), 0, 0.22, 0));
            body.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.02, 0.8), std(0x1b2a4a, 0.5, 0.25)), 0, 0.25, 0.5)); // solar panel
            const mast = at(new THREE.Group(), 0.35, 0.22, -0.7);
            body.add(mast);
            mast.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.05, 1.1, 8), dark), 0, 0.55, 0));
            const cam = at(new THREE.Group(), 0, 1.15, 0);
            mast.add(cam);
            cam.add(new THREE.Mesh(rbox(0.36, 0.16, 0.16, 0.03), white));
            for (const s of [-1, 1]) cam.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.04, 0.04, 0.03, 12), glowMat(0x66ccff, 2)), s * 0.1, 0, -0.085).rotateX(Math.PI / 2));
            const parts: Record<string, THREE.Object3D> = { body, cam };
            for (let i = 0; i < 6; i++) {
                const s = i % 2 ? 1 : -1, z = -0.75 + Math.floor(i / 2) * 0.75;
                const wheel = at(new THREE.Mesh(new THREE.CylinderGeometry(0.26, 0.26, 0.2, 18), dark), s * 0.72, -0.48, z);
                wheel.rotation.z = Math.PI / 2;
                root.add(wheel);
                parts[`wheel${i}`] = wheel;
                body.add(at(new THREE.Mesh(new THREE.BoxGeometry(0.06, 0.06, 0.5), dark), s * 0.66, -0.3, z));
            }
            // The drill arm at the front.
            const arm = at(new THREE.Group(), -0.3, -0.05, -1.0);
            body.add(arm);
            arm.add(at(new THREE.Mesh(new THREE.CylinderGeometry(0.035, 0.035, 0.6, 8), dark), 0, -0.3, 0));
            const drill = at(new THREE.Mesh(new THREE.ConeGeometry(0.06, 0.22, 10), gold), 0, -0.7, 0);
            drill.rotation.x = Math.PI;
            arm.add(drill);
            parts.arm = arm;
            parts.drill = drill;
            return { root, parts, chest: 0.8, radius: 1.2 };
        }
    }
}

// ---------------------------------------------------------------------------
// Enemies on foot.
// ---------------------------------------------------------------------------

export interface FoeDef {
    name: string;
    hp: number;
    /** m/s. */
    speed: number;
    /** 'melee' bite/slam at `reach`; 'ranged' shoots from `range`. */
    attack: 'melee' | 'ranged';
    damage: number;
    /** Seconds between attacks. */
    cooldown: number;
    reach: number;
    range: number;
    /** Hovering height above the ground, m (0 on foot). */
    hover: number;
    score: number;
    boltColor: number;
}

export const FOES: Record<GroundKind, FoeDef> = {
    skitter: { name: 'Скиттер', hp: 35, speed: 6.5, attack: 'melee', damage: 7, cooldown: 0.9, reach: 1.7, range: 0, hover: 0, score: 60, boltColor: 0xff4020 },
    sentinel: { name: 'Шагоход-страж', hp: 130, speed: 2.6, attack: 'ranged', damage: 11, cooldown: 1.7, reach: 0, range: 38, hover: 0, score: 160, boltColor: 0xff3a1a },
    wraith: { name: 'Призрачный охотник', hp: 60, speed: 5.5, attack: 'ranged', damage: 8, cooldown: 1.2, reach: 0, range: 30, hover: 5, score: 120, boltColor: 0xc060ff },
    brute: { name: 'Громила', hp: 320, speed: 3.4, attack: 'melee', damage: 24, cooldown: 1.6, reach: 2.8, range: 0, hover: 0, score: 320, boltColor: 0xff8020 },
};

export function makeFoe(kind: GroundKind): Rig {
    const root = new THREE.Group();
    const armor = std(0x26282e, 0.8, 0.4), plate = std(0x4a4d55, 0.7, 0.45);
    switch (kind) {
        case 'skitter': {
            const body = at(new THREE.Group(), 0, 0.5, 0);
            root.add(body);
            const shell = new THREE.Mesh(new THREE.SphereGeometry(0.45, 18, 12), armor);
            shell.scale.set(1, 0.45, 1.3);
            body.add(shell);
            for (let i = 0; i < 5; i++) {
                const spike = at(new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.22, 6), plate), 0, 0.2, 0.3 - i * 0.15);
                spike.rotation.x = 0.4;
                body.add(spike);
            }
            for (let i = 0; i < 4; i++) body.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.045, 8, 6), glowMat(0xff2010, 4)), (i % 2 ? 1 : -1) * (0.06 + Math.floor(i / 2) * 0.1), 0.05, -0.55));
            const mand = at(new THREE.Mesh(new THREE.ConeGeometry(0.05, 0.25, 6), plate), 0, -0.05, -0.62);
            mand.rotation.x = -Math.PI / 2;
            body.add(mand);
            const parts: Record<string, THREE.Object3D> = { body };
            for (let i = 0; i < 8; i++) {
                const s = i % 2 ? 1 : -1, z = 0.35 - Math.floor(i / 2) * 0.23;
                const leg = at(new THREE.Group(), s * 0.3, 0, z);
                body.add(leg);
                const up = at(new THREE.Mesh(new THREE.CylinderGeometry(0.025, 0.02, 0.5, 5), plate), s * 0.2, 0.15, 0);
                up.rotation.z = -s * 0.9;
                leg.add(up);
                const low = at(new THREE.Mesh(new THREE.CylinderGeometry(0.02, 0.006, 0.7, 5), armor), s * 0.5, -0.2, 0);
                low.rotation.z = s * 0.45;
                leg.add(low);
                parts[`leg${i}`] = leg;
            }
            return { root, parts, chest: 0.5, radius: 0.75 };
        }
        case 'sentinel': {
            const hull = at(new THREE.Group(), 0, 2.4, 0);
            root.add(hull);
            hull.add(new THREE.Mesh(rbox(1.2, 0.8, 1.3, 0.12), plate));
            hull.add(at(new THREE.Mesh(rbox(1.0, 0.3, 0.4, 0.08), armor), 0, 0.35, -0.4));
            hull.add(at(new THREE.Mesh(rbox(0.8, 0.07, 0.05, 0.02), glowMat(0xff2a10, 4)), 0, 0.1, -0.66));
            for (const s of [-1, 1]) {
                const gun = at(new THREE.Mesh(new THREE.CylinderGeometry(0.07, 0.09, 1.1, 10), armor), s * 0.7, -0.1, -0.5);
                gun.rotation.x = Math.PI / 2;
                hull.add(gun);
            }
            const parts: Record<string, THREE.Object3D> = { hull };
            for (const s of [-1, 1]) {
                const hip = at(new THREE.Group(), s * 0.5, -0.35, 0.1);
                hull.add(hip);
                const thigh = at(new THREE.Mesh(rbox(0.22, 1.0, 0.3, 0.06), plate), 0, -0.45, -0.2);
                thigh.rotation.x = 0.45;
                hip.add(thigh);
                const shin = at(new THREE.Mesh(rbox(0.16, 1.1, 0.2, 0.05), armor), 0, -1.2, -0.1);
                shin.rotation.x = -0.5;
                hip.add(shin);
                hip.add(at(new THREE.Mesh(rbox(0.36, 0.1, 0.55, 0.04), plate), 0, -1.95, -0.12));
                parts[s < 0 ? 'legL' : 'legR'] = hip;
            }
            return { root, parts, chest: 2.4, radius: 1.1 };
        }
        case 'wraith': {
            const body = at(new THREE.Group(), 0, 0, 0);
            root.add(body);
            body.add(new THREE.Mesh(new THREE.OctahedronGeometry(0.35, 0), glowMat(0xb050ff, 4)));
            body.add(new THREE.Mesh(new THREE.SphereGeometry(0.9, 16, 12), addMat(0x8030ff, 0.12)));
            const shards = new THREE.Group();
            body.add(shards);
            const shardMat = std(0x16121e, 0.9, 0.2, 0x3a1060, 0.6);
            for (let i = 0; i < 6; i++) {
                const a = (i / 6) * Math.PI * 2;
                const sh = at(new THREE.Mesh(new THREE.ConeGeometry(0.14, 0.9, 4), shardMat), Math.cos(a) * 0.55, Math.sin(i * 2.1) * 0.2, Math.sin(a) * 0.55);
                sh.lookAt(0, 0, 0);
                sh.rotateX(Math.PI / 2);
                shards.add(sh);
            }
            const tails: THREE.Object3D[] = [];
            for (let i = 0; i < 3; i++) {
                const t = at(new THREE.Mesh(new THREE.ConeGeometry(0.09, 1.6, 6, 1, true), addMat(0x9040ff, 0.4)), (i - 1) * 0.2, -1.0, 0.1);
                t.rotation.x = Math.PI;
                body.add(t);
                tails.push(t);
            }
            return { root, parts: { body, shards, tail0: tails[0], tail1: tails[1], tail2: tails[2] }, chest: 0, radius: 0.8 };
        }
        case 'brute': {
            const lava = glowMat(0xff6a1a, 2.5);
            const body = at(new THREE.Group(), 0, 1.6, 0);
            root.add(body);
            const chest = new THREE.Mesh(new THREE.SphereGeometry(0.9, 18, 14), std(0x2e2520, 0.2, 0.85));
            chest.scale.set(1.2, 0.95, 1);
            body.add(chest);
            for (let i = 0; i < 5; i++) {
                const plateM = at(new THREE.Mesh(rbox(0.6, 0.4, 0.2, 0.08), armor), Math.sin(i * 1.3) * 0.5, 0.3 + (i % 2) * 0.3, -0.75 + Math.abs(Math.sin(i)) * 0.2);
                plateM.rotation.set(0.3, i * 0.4, 0.2);
                body.add(plateM);
            }
            body.add(at(new THREE.Mesh(new THREE.TorusGeometry(0.5, 0.05, 6, 20), lava), 0, 0.05, -0.8));
            const head = at(new THREE.Group(), 0, 0.55, -0.85);
            body.add(head);
            head.add(new THREE.Mesh(rbox(0.5, 0.4, 0.45, 0.12), armor));
            for (const s of [-1, 1]) head.add(at(new THREE.Mesh(new THREE.SphereGeometry(0.06, 8, 6), lava), s * 0.13, 0.03, -0.23));
            const parts: Record<string, THREE.Object3D> = { body, head };
            for (const s of [-1, 1]) {
                const arm = at(new THREE.Group(), s * 1.05, 0.35, -0.2);
                body.add(arm);
                arm.add(at(new THREE.Mesh(new THREE.CapsuleGeometry(0.26, 0.7, 4, 10), std(0x2e2520, 0.2, 0.85)), 0, -0.55, 0));
                arm.add(at(new THREE.Mesh(rbox(0.6, 0.5, 0.6, 0.14), armor), 0, -1.25, -0.1));
                parts[s < 0 ? 'armL' : 'armR'] = arm;
                const leg = at(new THREE.Group(), s * 0.5, -0.7, 0.2);
                body.add(leg);
                leg.add(at(new THREE.Mesh(new THREE.CapsuleGeometry(0.24, 0.5, 4, 10), std(0x2e2520, 0.2, 0.85)), 0, -0.4, 0));
                parts[s < 0 ? 'legL' : 'legR'] = leg;
            }
            return { root, parts, chest: 1.7, radius: 1.3 };
        }
    }
}

/** Crystal samples (or whatever the world offers) waiting to be picked up, with a pillar of light over them. */
export function makeItem(color: number): THREE.Group {
    const g = new THREE.Group();
    const mat = new THREE.MeshStandardMaterial({ color: 0x101010, emissive: color, emissiveIntensity: 2.2, metalness: 0.2, roughness: 0.15, flatShading: true });
    const rng = mulberry32(color);
    for (let i = 0; i < 4; i++) {
        const m = at(new THREE.Mesh(new THREE.OctahedronGeometry(0.12 + rng() * 0.12, 0), mat), (rng() - 0.5) * 0.4, 0.12 + rng() * 0.1, (rng() - 0.5) * 0.4);
        m.scale.y = 1.8;
        m.rotation.set(rng() - 0.5, rng() * 3, rng() - 0.5);
        g.add(m);
    }
    const pillar = at(new THREE.Mesh(new THREE.CylinderGeometry(0.25, 0.6, 60, 12, 1, true), addMat(color, 0.18)), 0, 30, 0);
    pillar.name = 'pillar';
    g.add(pillar);
    return g;
}
