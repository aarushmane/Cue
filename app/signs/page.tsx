// Printable venue signs for visual localization (docs/venue-landmarks.md). One sign per page, A4 landscape;
// print at A3 (scale up) if the printer allows. Each sign matches its DEMO_LANDMARKS description exactly:
// unique color, shape, number, printed word and icon, so the model can tell them apart from a partial view.
import type { Metadata } from "next";
import type { ReactNode } from "react";
import { Apple, CircleQuestionMark, Milk, ShoppingCart } from "lucide-react";
import { DEMO_LANDMARKS } from "@/lib/seed/demo-store";

export const metadata: Metadata = { title: "StoreGuide · Venue signs" };

const W = 1000;
const H = 700;
const ICON = { strokeWidth: 2.25, absoluteStrokeWidth: false } as const;

/** Simple tin can (lucide has none). */
function Can({ x, y, size, color }: { x: number; y: number; size: number; color: string }) {
  return (
    <svg x={x} y={y} width={size} height={size} viewBox="0 0 24 24" fill="none" stroke={color} strokeWidth={2.25} strokeLinecap="round">
      <ellipse cx="12" cy="5" rx="7" ry="2.5" />
      <path d="M5 5v14c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5V5" />
      <path d="M5 10c0 1.4 3.1 2.5 7 2.5s7-1.1 7-2.5" />
    </svg>
  );
}

interface Sign {
  id: string;
  label: string; // what is printed, for the accessible name
  art: ReactNode;
}

const text = (x: number, y: number, size: number, fill: string, body: string, weight = 900) => (
  <text x={x} y={y} fontSize={size} fontWeight={weight} fill={fill} textAnchor="middle" fontFamily="Arial, Helvetica, sans-serif">
    {body}
  </text>
);

const SIGNS: Sign[] = [
  {
    id: "L01",
    label: "Green rectangular banner: WELCOME TO STOREGUIDE, shopping-cart icon",
    art: (
      <>
        <rect x={20} y={110} width={960} height={480} rx={24} fill="#1E8A4C" />
        <ShoppingCart x={430} y={150} width={140} height={140} color="#FFFFFF" {...ICON} />
        {text(500, 400, 96, "#FFFFFF", "WELCOME TO")}
        {text(500, 520, 120, "#FFFFFF", "STOREGUIDE")}
      </>
    ),
  },
  {
    id: "L02",
    label: "Red square sign: number 1, PRODUCE & BAKERY, apple icon",
    art: (
      <>
        <rect x={180} y={20} width={640} height={660} fill="#D7263D" />
        <Apple x={445} y={40} width={110} height={110} color="#FFFFFF" {...ICON} />
        {text(500, 420, 290, "#FFFFFF", "1")}
        {text(500, 545, 76, "#FFFFFF", "PRODUCE &")}
        {text(500, 640, 76, "#FFFFFF", "BAKERY")}
      </>
    ),
  },
  {
    id: "L03",
    label: "Blue round sign: number 2, DAIRY, milk-carton icon",
    art: (
      <>
        <circle cx={500} cy={350} r={335} fill="#1E5AA8" />
        <Milk x={440} y={60} width={120} height={120} color="#FFFFFF" {...ICON} />
        {text(500, 470, 320, "#FFFFFF", "2")}
        {text(500, 590, 90, "#FFFFFF", "DAIRY")}
      </>
    ),
  },
  {
    id: "L04",
    label: "Yellow triangle sign, point up: number 3, PANTRY, tin-can icon",
    art: (
      <>
        <polygon points="500,15 985,685 15,685" fill="#F2C200" stroke="#000000" strokeWidth={10} strokeLinejoin="round" />
        <Can x={450} y={200} size={100} color="#000000" />
        {text(500, 560, 280, "#000000", "3")}
        {text(500, 655, 84, "#000000", "PANTRY")}
      </>
    ),
  },
  {
    id: "L05",
    label: "Orange sign: HELP, question-mark icon",
    art: (
      <>
        <rect x={60} y={90} width={880} height={520} rx={60} fill="#F07F13" />
        <CircleQuestionMark x={410} y={130} width={180} height={180} color="#000000" {...ICON} />
        {text(500, 540, 220, "#000000", "HELP")}
      </>
    ),
  },
];

export default function SignsPage() {
  const desc = new Map(DEMO_LANDMARKS.map((l) => [l.id, l.description]));
  return (
    <main className="mx-auto max-w-[1000px] bg-white p-4 text-black print:max-w-none print:p-0">
      <style>{`@page { size: A4 landscape; margin: 8mm; } @media print { .sign-page { break-after: page; height: 190mm; } .sign-page:last-child { break-after: auto; } }`}</style>
      <header className="mb-6 flex flex-col gap-2 print:hidden">
        <h1 className="m-0 text-3xl font-extrabold">Venue signs for visual localization</h1>
        <p className="m-0">
          Print each sign on its own page (A4 landscape, or scale to A3). Mount it matte, 1.2–1.5 m off the floor, facing the walkway, at its map
          point. Don&apos;t put other signs in these colors nearby. Then take one reference photo per sign (see docs/venue-landmarks.md).
        </p>
      </header>
      {SIGNS.map((s) => (
        <section key={s.id} className="sign-page mb-10 flex flex-col items-center gap-2 print:mb-0">
          <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={`${s.id}: ${s.label}`} className="h-auto w-full print:h-full">
            {s.art}
          </svg>
          <p className="m-0 text-sm text-gray-700 print:hidden">
            <strong>{s.id}</strong> description the model gets: {desc.get(s.id)}
          </p>
        </section>
      ))}
    </main>
  );
}
