import { useEffect, useState } from "react";
import { AnimatePresence, motion } from "framer-motion";

const reducedMotion = () => typeof window !== "undefined" && window.matchMedia("(prefers-reduced-motion: reduce)").matches;

// Hero title: "Every" stays; the second line slides up from "call answered." to "meeting booked." and back.
const HERO_WORDS = ["call answered.", "meeting booked."];
export default function HeroTitle() {
  const [i, setI] = useState(0);
  useEffect(() => {
    if (reducedMotion()) return;
    const t = setInterval(() => setI((n) => (n + 1) % HERO_WORDS.length), 2600);
    return () => clearInterval(t);
  }, []);
  if (reducedMotion()) return <span aria-hidden>Every call answered. Every meeting booked.</span>;
  return (
    <span aria-hidden className="block">
      <span className="block">Every</span>
      <span className="relative block h-[1.15em] overflow-hidden">
        {/* one phrase at a time: the old one slides up and out, then the new one rises in */}
        <AnimatePresence initial={false} mode="wait">
          <motion.span key={i} className="absolute inset-x-0 top-0 block whitespace-nowrap"
            initial={{ y: "70%", opacity: 0 }} animate={{ y: "0%", opacity: 1 }} exit={{ y: "-70%", opacity: 0 }}
            transition={{ duration: 0.32, ease: [0.22, 1, 0.36, 1] }}>
            {HERO_WORDS[i]}
          </motion.span>
        </AnimatePresence>
      </span>
    </span>
  );
}
