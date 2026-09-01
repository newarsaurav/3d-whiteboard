"use client";

import dynamic from "next/dynamic";

if (typeof window !== "undefined") {
  const warn = console.warn.bind(console);
  console.warn = (...args: unknown[]) => {
    const text = args.map(String).join(" ");
    if (text.includes("THREE.Clock") || text.includes("Please use THREE.Timer")) {
      return;
    }
    warn(...args);
  };
}

const LixiaStudio = dynamic(() => import("@/components/LixiaStudio"), {
  ssr: false,
  loading: () => (
    <main className="studio">
      <p style={{ padding: 24, color: "#9fa6b8" }}>Loading studio…</p>
    </main>
  ),
});

export default function HomePage() {
  return <LixiaStudio />;
}
