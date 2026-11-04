import DashboardLayout from "@/components/DashboardLayout";
import { Mail } from "lucide-react";

const XLogo = ({ className }: { className?: string }) => (
  <svg viewBox="0 0 24 24" fill="currentColor" aria-hidden className={className}>
    <path d="M18.244 2.25h3.308l-7.227 8.26 8.502 11.24H16.17l-5.214-6.817L4.99 21.75H1.68l7.73-8.835L1.254 2.25H8.08l4.713 6.231 5.45-6.231Zm-1.161 17.52h1.833L7.084 4.126H5.117L17.083 19.77Z" />
  </svg>
);

const supportCards = [
  { icon: XLogo, title: "X", description: "Follow @VamsiBuilds for updates, or send a message.", href: "https://x.com/VamsiBuilds" },
  { icon: Mail, title: "Email", description: "support@letargue.com", href: "mailto:support@letargue.com" },
];

/** The support links; shown on its own page and in the account window. */
export function SupportContent() {
  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      {supportCards.map((card) => (
        <a
          key={card.title}
          href={card.href}
          target={card.href.startsWith("http") ? "_blank" : undefined}
          rel="noopener noreferrer"
          className="flex items-start gap-4 rounded-xl border border-border bg-card p-6 transition-colors hover:bg-muted"
        >
          <card.icon className="mt-0.5 h-6 w-6 shrink-0 text-muted-foreground" />
          <div className="space-y-1">
            <span className="font-semibold">{card.title}</span>
            <p className="text-sm text-muted-foreground">{card.description}</p>
          </div>
        </a>
      ))}
    </div>
  );
}

export default function Support() {
  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Support</h1>
          <p className="text-muted-foreground mt-1">
            Questions or feedback? Reach us on X or by email.
          </p>
        </div>
        <SupportContent />
      </div>
    </DashboardLayout>
  );
}
