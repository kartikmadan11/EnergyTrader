import type { Metadata } from "next";
import Blotter from "./Blotter";

export const metadata: Metadata = { title: "Blotter" };

const SESSION_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export default async function BlotterPage({ searchParams }: PageProps<"/blotter">) {
  const { session } = await searchParams;
  // ?session=<id> opens that session's detail, so a link can point straight at one bid set.
  const initialSession = typeof session === "string" && SESSION_ID.test(session) ? session.toLowerCase() : null;
  return <Blotter initialSession={initialSession} />;
}
