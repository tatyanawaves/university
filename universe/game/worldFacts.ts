// True things about the place the pilot is in, for the creatures to talk about:
// worked out from the system's own numbers (distance, light time, year, day,
// size, gravity), plus what is known of the real Solar System. The model gets
// them so it does not make numbers up; the scripted talk tells them itself.

import { AU_KM } from '../physics';

const R_EARTH_KM = 6371;
/** Light crosses 1 AU in this many seconds. */
const AU_LIGHT_S = 499.005;

export interface FactStar { name: string; T: number; L: number }

export interface FactBody {
    name: string;
    kind: string;
    aKm: number;
    periodDays: number;
    dayDays: number;
    radiusKm: number;
    massEarth: number;
    tilt?: number;
    rings?: boolean;
    moons?: FactBody[];
}

/** What spacecraft and telescopes found at the real bodies. */
const KNOWN: Record<string, string[]> = {
    'Меркурий': ['На Меркурии днём до +430 °C, а ночью до −180 °C: воздуха нет, и тепло не держится.'],
    'Венера': [
        'Венера оборачивается вокруг оси дольше, чем вокруг Солнца, и крутится в обратную сторону: Солнце там встаёт на западе.',
        'У поверхности Венеры +465 °C и давление в 92 раза больше земного.',
    ],
    'Луна': ['Луна уходит от Земли примерно на 3,8 см в год.'],
    'Марс': ['На Марсе стоит Олимп — вулкан высотой около 22 км, в два с половиной раза выше Эвереста.'],
    'Фобос': ['Фобос медленно падает на Марс: через несколько десятков миллионов лет его разорвут приливы.'],
    'Юпитер': ['Большое Красное Пятно на Юпитере — шторм шире Земли; его наблюдают почти двести лет.'],
    'Ио': ['Ио — самый вулканический мир Солнечной системы: сотни действующих вулканов.'],
    'Европа': ['Под ледяной коркой Европы — солёный океан, и воды в нём, по оценкам, больше, чем во всех океанах Земли.'],
    'Ганимед': ['Ганимед больше Меркурия, и у него есть собственное магнитное поле, единственное среди спутников.'],
    'Каллисто': ['Каллисто вся изрыта кратерами: её поверхности около четырёх миллиардов лет.'],
    'Сатурн': ['Средняя плотность Сатурна меньше, чем у воды: в достаточно большом океане он бы плавал.'],
    'Энцелад': ['Из трещин на юге Энцелада бьют гейзеры водяного пара, и из них сложено кольцо E Сатурна.'],
    'Титан': ['На Титане идут метановые дожди, а у полюсов лежат моря жидких углеводородов.'],
    'Япет': ['Япет двуцветный: одна его сторона тёмная, как уголь, другая белая, как снег.'],
    'Уран': ['Уран лежит на боку: ось наклонена на 98°, и каждый полюс по 42 года не видит Солнца.'],
    'Миранда': ['На Миранде есть обрыв Верона высотой около 20 км, один из самых высоких в Солнечной системе.'],
    'Нептун': ['На Нептуне самые быстрые ветры в Солнечной системе, до 2000 км/ч.'],
    'Тритон': ['Тритон ходит вокруг Нептуна в обратную сторону: скорее всего, это пойманный карлик из пояса Койпера.'],
};

/** A number the Russian way: a decimal comma, few digits. */
function num(x: number, digits = 1): string {
    const r = Math.abs(x) >= 100 ? Math.round(x).toString() : x.toFixed(Math.abs(x) >= 10 ? 0 : digits);
    return r.replace('.', ',').replace(/,0+$/, '');
}

function span(days: number): string {
    const d = Math.abs(days);
    if (d < 2 / 24) return `${num(d * 1440, 0)} мин`;
    if (d < 2) return `${num(d * 24)} ч`;
    if (d < 700) return `${num(d)} сут.`;
    return `${num(d / 365.25)} земных лет`;
}

/** End with a full stop, unless the last word already has one («сут.»). */
const sentence = (s: string) => (s.endsWith('.') ? s : `${s}.`);

function lightTime(km: number): string {
    const s = (km / AU_KM) * AU_LIGHT_S;
    if (s < 90) return `${num(s)} с`;
    if (s < 5400) return `${num(s / 60)} мин`;
    return `${num(s / 3600)} ч`;
}

function starColour(T: number): string {
    return T < 3700 ? 'красноватый' : T < 5200 ? 'оранжевый' : T < 6000 ? 'жёлто-белый' : T < 7500 ? 'белый' : 'голубоватый';
}

function bodyFacts(b: FactBody, parent: FactBody | null): string[] {
    const out: string[] = [];
    const r = b.radiusKm / R_EARTH_KM;
    const g = b.massEarth / (r * r);
    const retro = b.dayDays < 0 ? ', и вращение обратное' : '';
    const size = r >= 1.15 ? `в ${num(r)} раза больше Земли` : r <= 0.87 ? `в ${num(1 / r)} раза меньше Земли` : 'почти с Землю';
    const gravity = b.kind === 'gas' || b.kind === 'ice-giant' ? `у верхушек облаков тяжесть ${num(g, 2)} g` : `тяжесть ${num(g, 2)} g`;
    if (parent) {
        const locked = Math.abs(Math.abs(b.dayDays) - b.periodDays) < 1e-6 * b.periodDays + 1e-9;
        out.push(sentence(`${b.name}: оборот вокруг планеты ${parent.name} — ${span(b.periodDays)}${locked ? ', и к планете всегда обращена одна и та же сторона' : ''}; ${gravity}`));
    } else {
        out.push(sentence(`${b.name}: до звезды ${num(b.aKm / AU_KM, 2)} а.е., свет идёт оттуда ${lightTime(b.aKm)}, а год длится ${span(b.periodDays)}`));
        const extra = [b.rings ? 'есть кольца' : '', b.moons?.length ? `спутников — ${b.moons.length}` : ''].filter(Boolean).join(', ');
        out.push(sentence(`${b.name}: размером ${size}, ${gravity}, сутки длятся ${span(b.dayDays)}${retro}${extra ? `; ${extra}` : ''}`));
    }
    out.push(...(KNOWN[b.name] ?? []));
    return out;
}

/** Everything true to say about a system: its star, every planet and moon. */
export function systemFacts(star: FactStar, bodies: FactBody[]): string[] {
    const bright = star.L >= 1.5 ? `светит в ${num(star.L)} раза ярче Солнца` : star.L <= 0.67 ? `светит в ${num(1 / star.L)} раза тусклее Солнца` : 'светит почти как Солнце';
    const facts = [`Звезда ${star.name} горит при ${Math.round(star.T)} К — свет у неё ${starColour(star.T)}, и она ${bright}.`];
    for (const b of bodies) {
        facts.push(...bodyFacts(b, null));
        for (const m of b.moons ?? []) facts.push(...bodyFacts(m, b));
    }
    return facts;
}

/** Facts about one world seen from its surface, first, then the rest of its system. */
export function surfaceFacts(name: string, gravity: number, dayDays: number, air: boolean, system: string[]): string[] {
    const here = [
        sentence(`${name}: здесь, на поверхности, тяжесть ${num(gravity / 9.807, 2)} g, а сутки длятся ${span(dayDays)}`),
        air ? `${name}: здесь есть воздух, и небо светится.` : `${name}: воздуха здесь нет, и небо чёрное даже днём.`,
    ];
    return [...here, ...system.filter(f => f.includes(name)), ...system.filter(f => !f.includes(name))];
}
