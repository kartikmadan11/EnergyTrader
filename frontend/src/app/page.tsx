import Link from "next/link";
import { auth } from "@/auth";
import BrandMark from "@/components/BrandMark";
import PriceCurve from "@/components/PriceCurve";
import { HOME_PATH } from "@/lib/access";

const SOURCE_URL = "https://github.com/kartikmadan11/EnergyTrader";

const facts = [
  { value: "96", label: "blocks per delivery day" },
  { value: "7", label: "pre-trade checks" },
  { value: "3", label: "market segments" },
];

const steps = [
  {
    title: "Forecast",
    body: "A gradient-boosted model per segment prices every block of the delivery day, with an interval around each one.",
  },
  {
    title: "Optimize",
    body: "A linear program sizes each block's bid, weighing bid value against DSM penalty exposure and forecast uncertainty.",
  },
  {
    title: "Check",
    body: "Seven pre-trade checks return a verdict. Hard failures block submission, and the server runs them again on submit.",
  },
  {
    title: "Review",
    body: "The trade blotter follows every submitted session to clearing, and post-market analysis scores the forecast.",
  },
];

export default async function LandingPage() {
  const session = await auth();
  const signedIn = Boolean(session?.user?.id);
  const primary = signedIn
    ? { href: HOME_PATH, label: "Open the workstation" }
    : { href: "/login", label: "Sign in" };

  return (
    <div className="relative min-h-screen bg-[#07111D] text-white">
      <div className="pointer-events-none absolute inset-x-0 top-0 h-[560px] bg-[radial-gradient(60%_70%_at_75%_0%,rgba(0,109,174,0.28),transparent)]" />

      <header className="relative mx-auto flex h-16 max-w-6xl items-center justify-between px-6">
        <Link href="/" className="flex items-center gap-2.5 text-[15px] font-semibold tracking-tight">
          <BrandMark className="h-6 w-6" />
          EnergyTrader
        </Link>
        <nav className="flex items-center gap-6 text-sm">
          <a href={SOURCE_URL} className="text-white/60 transition-colors hover:text-white">
            Source
          </a>
          <Link
            href={primary.href}
            className="rounded-md bg-white px-3.5 py-1.5 font-medium text-[#07111D] transition-colors hover:bg-white/90"
          >
            {signedIn ? "Workstation" : "Sign in"}
          </Link>
        </nav>
      </header>

      <main className="relative">
        <section className="mx-auto grid max-w-6xl items-center gap-14 px-6 pb-20 pt-16 lg:grid-cols-[1fr_1.15fr] lg:pt-24">
          <div>
            <p className="text-xs font-medium uppercase tracking-[0.18em] text-[#00B398]">
              Indian power exchanges · DAM · RTM · TAM
            </p>
            <h1 className="mt-5 text-balance text-4xl font-semibold leading-[1.08] tracking-tight sm:text-5xl">
              Bid the next delivery day, fifteen minutes at a time.
            </h1>
            <p className="mt-6 max-w-xl text-lg leading-relaxed text-white/65">
              EnergyTrader forecasts every clearing price for the day, sizes each block&apos;s bid
              with a linear program, and checks the set against the active DSM regulation before it
              is recorded.
            </p>
            <div className="mt-9 flex flex-wrap items-center gap-3">
              <Link
                href={primary.href}
                className="rounded-md bg-[#006DAE] px-5 py-2.5 text-sm font-medium transition-colors hover:bg-[#0A7DC4]"
              >
                {primary.label}
              </Link>
              <a
                href={SOURCE_URL}
                className="rounded-md border border-white/15 px-5 py-2.5 text-sm font-medium text-white/80 transition-colors hover:border-white/30 hover:text-white"
              >
                Read the source
              </a>
            </div>
            <dl className="mt-12 flex divide-x divide-white/10">
              {facts.map((fact) => (
                <div key={fact.label} className="flex flex-col-reverse px-6 first:pl-0">
                  <dt className="mt-1 text-xs text-white/45">{fact.label}</dt>
                  <dd className="text-2xl font-semibold tabular-nums">{fact.value}</dd>
                </div>
              ))}
            </dl>
          </div>

          <div className="rounded-xl border border-white/10 bg-white/[0.03] p-6 shadow-[0_30px_80px_-30px_rgba(0,0,0,0.6)]">
            <div className="mb-5 flex items-center justify-between">
              <p className="text-sm font-medium text-white/85">Day-Ahead forecast · next delivery day</p>
              <span className="rounded-full border border-white/10 px-2.5 py-0.5 text-[11px] text-white/45">
                Illustrative
              </span>
            </div>
            <PriceCurve />
            <div className="mt-5 flex flex-wrap gap-x-5 gap-y-2 border-t border-white/10 pt-4 text-xs text-white/50">
              <span className="flex items-center gap-2">
                <span className="h-0.5 w-4 rounded-full bg-[#5DB8F0]" />
                Forecast price
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-4 rounded-sm bg-[#00B398]/30" />
                95% interval
              </span>
              <span className="flex items-center gap-2">
                <span className="h-2.5 w-1.5 rounded-sm bg-white/25" />
                Bid volume
              </span>
            </div>
          </div>
        </section>

        <section className="border-t border-white/10">
          <div className="mx-auto max-w-6xl px-6 py-20">
            <h2 className="text-2xl font-semibold tracking-tight">From forecast to review</h2>
            <p className="mt-3 max-w-2xl text-white/55">
              One workflow for the bidding desk, with every step written to the audit trail.
            </p>
            <ol className="mt-12 grid gap-px overflow-hidden rounded-xl border border-white/10 bg-white/10 sm:grid-cols-2 lg:grid-cols-4">
              {steps.map((step, i) => (
                <li key={step.title} className="bg-[#07111D] p-6">
                  <p className="text-xs font-medium tabular-nums text-[#00B398]">
                    {String(i + 1).padStart(2, "0")}
                  </p>
                  <h3 className="mt-4 font-medium">{step.title}</h3>
                  <p className="mt-2 text-sm leading-relaxed text-white/55">{step.body}</p>
                </li>
              ))}
            </ol>
          </div>
        </section>
      </main>

      <footer className="border-t border-white/10">
        <div className="mx-auto flex max-w-6xl flex-col gap-3 px-6 py-8 text-xs text-white/40 sm:flex-row sm:items-center sm:justify-between">
          <p>
            Decision support for bidding. EnergyTrader does not connect to an exchange or place
            orders, and the prices on this page are illustrative.
          </p>
          <a href={SOURCE_URL} className="shrink-0 transition-colors hover:text-white/70">
            Source on GitHub
          </a>
        </div>
      </footer>
    </div>
  );
}
