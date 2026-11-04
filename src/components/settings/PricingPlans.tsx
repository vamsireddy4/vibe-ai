import { ADMIN_EMAIL } from "@/lib/constants";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Check, Timer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useEffect, useState } from "react";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";

type PaidPlan = {
  name: string;
  description: string;
  price: string;
  minutes: string;
  featured: boolean;
  enterprise?: false;
};

type EnterprisePlan = {
  name: string;
  description: string;
  price: string;
  minutes: string;
  featured: boolean;
  enterprise: true;
};

type Plan = PaidPlan | EnterprisePlan;

// ponytail: no payment links yet; every plan button opens a Gmail draft to the sales inbox. Add checkout links here later.
const PLAN_REQUEST_EMAIL = "support@letargue.com";

/** Open Gmail with a plan request to the sales inbox, the plan and account details already written. */
function emailPlanRequest(plan: { name: string; price: string; minutes: string }, accountEmail: string) {
  const subject = `Vibe AI plan request: ${plan.name}`;
  const body = [
    "Hi,",
    "",
    `I'd like the ${plan.name} plan (${plan.minutes} minutes, ${plan.price}). Please send me the details.`,
    "",
    `Account email: ${accountEmail}`,
  ].join("\n");
  const url = `https://mail.google.com/mail/?view=cm&fs=1&to=${encodeURIComponent(PLAN_REQUEST_EMAIL)}&su=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
  window.open(url, "_blank", "noopener,noreferrer");
}

const plans: readonly Plan[] = [
  {
    name: "Starter",
    description: "Perfect for getting started with AI calling",
    price: "$19",
    minutes: "190",
    featured: false,
  },
  {
    name: "Ultra",
    description: "Best fit for growing teams",
    price: "$149",
    minutes: "1500",
    featured: false,
  },
  {
    name: "Pro",
    description: "Most popular choice for power users",
    price: "$49",
    minutes: "500",
    featured: true,
  },
  {
    name: "Enterprise",
    description: "Best value for high-volume calling",
    price: "custom",
    minutes: "Custom",
    featured: false,
    enterprise: true,
  },
] as const;

const features = ["AI Voice Calling", "Never Expires", "Instant Activation"];
const STANDARD_RATE = 0.13; // $ per minute on muse-spark-1.3 (Contributor: the listed minutes)

/** Minute packages. Used by the Pricing page and the account window's Usage section (embedded: no page title, 2 columns). */
export default function PricingPlans({ embedded = false }: { embedded?: boolean }) {
  const { toast } = useToast();
  const { user, profile } = useAuth();
  const [availableSeconds, setAvailableSeconds] = useState<number | null>(null);
  const [purchasingPlan, setPurchasingPlan] = useState<string | null>(null);
  const [agencyData, setAgencyData] = useState<{
    email: string;
    agency_code?: string;
    client_rate_per_minute: number;
    custom_checkout_url?: string | null;
    checkout_url_starter?: string | null;
    checkout_url_pro?: string | null;
    checkout_url_ultra?: string | null;
    payment_instruction?: string | null;
    starter_custom_minutes?: number | null;
    starter_custom_price?: number | null;
    pro_custom_minutes?: number | null;
    pro_custom_price?: number | null;
    ultra_custom_minutes?: number | null;
    ultra_custom_price?: number | null;
  } | null>(null);
  const [loadingAgency, setLoadingAgency] = useState(false);
  const [instructionModalOpen, setInstructionModalOpen] = useState(false);
  const [selectedPlan, setSelectedPlan] = useState<(typeof plans)[number] | null>(null);
  const [requesting, setRequesting] = useState(false);

  const isAdmin = user?.email === ADMIN_EMAIL;

  useEffect(() => {
    if (!user) return;
    supabase
      .from("user_minute_balances")
      .select("available_seconds")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => setAvailableSeconds(data?.available_seconds ?? 0));
  }, [user]);

  useEffect(() => {
    const fetchAgency = async () => {
      setLoadingAgency(true);
      try {
        // 1. Check URL query parameters
        let codeFromUrl = "";
        let emailFromUrl = "";
        if (typeof window !== "undefined") {
          const params = new URLSearchParams(window.location.search);
          codeFromUrl = params.get("ref") || params.get("agency_code") || "";
          emailFromUrl = params.get("agency") || params.get("agency_email") || "";
          
          if (codeFromUrl) {
            localStorage.setItem("referred_agency_code", codeFromUrl);
          }
          if (emailFromUrl) {
            localStorage.setItem("referred_agency_email", emailFromUrl.trim().toLowerCase());
          }
        }

        // Resolve code and email by priority
        const resolvedCode = codeFromUrl || localStorage.getItem("referred_agency_code") || profile?.agency_code || "";
        const resolvedEmail = emailFromUrl || localStorage.getItem("referred_agency_email") || profile?.agency_email || "";

        let query = supabase.from("agency_access_grants").select("*").eq("is_active", true);
        
        let hasIdentifier = false;
        if (resolvedCode) {
          query = query.eq("agency_code", resolvedCode);
          hasIdentifier = true;
        } else if (resolvedEmail) {
          query = query.eq("email", resolvedEmail.trim().toLowerCase());
          hasIdentifier = true;
        } else if (user?.email) {
          // Fallback: Check if the logged-in user is the agency owner themselves
          query = query.eq("email", user.email.trim().toLowerCase());
          hasIdentifier = true;
        }

        if (!hasIdentifier) {
          setAgencyData(null);
          return;
        }

        const { data, error } = await query.maybeSingle();
        if (!error && data) {
          setAgencyData({
            email: data.email,
            agency_code: data.agency_code,
            client_rate_per_minute: data.client_rate_per_minute ?? 0.15,
            custom_checkout_url: data.custom_checkout_url,
            checkout_url_starter: data.checkout_url_starter,
            checkout_url_pro: data.checkout_url_pro,
            checkout_url_ultra: data.checkout_url_ultra,
            payment_instruction: data.payment_instruction,
            starter_custom_minutes: data.starter_custom_minutes,
            starter_custom_price: data.starter_custom_price,
            pro_custom_minutes: data.pro_custom_minutes,
            pro_custom_price: data.pro_custom_price,
            ultra_custom_minutes: data.ultra_custom_minutes,
            ultra_custom_price: data.ultra_custom_price,
          });
        } else {
          setAgencyData(null);
        }
      } catch (err) {
        console.error("Failed to load referring agency details:", err);
        setAgencyData(null);
      } finally {
        setLoadingAgency(false);
      }
    };

    void fetchAgency();
  }, [profile, user]);

  const requestEnterprisePlan = async () => {
    const { error } = await supabase.auth.updateUser({
      data: {
        enterprise_interest: true,
        enterprise_requested_at: new Date().toISOString(),
      },
    });

    if (error) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
      return;
    }

    toast({ title: "Enterprise request sent", description: "Your pricing request has been submitted." });
  };

  // Listed minutes are at the Muse Spark 1.3 Contributor rate; standard Muse Spark 1.3 costs $0.13 a minute.
  const contributor = String(profile?.voice_llm_model ?? "").endsWith("-contributor");
  const byModel = (planName: string, minutes: string) => {
    const price = Number(plans.find((p) => p.name === planName)?.price.replace("$", ""));
    return contributor || !Number.isFinite(price) ? minutes : String(Math.floor(price / STANDARD_RATE));
  };

  const getPlanMinutes = (planName: string, defaultMinutes: string) => {
    if (!agencyData) return byModel(planName, defaultMinutes);
    if (planName === "Starter" && agencyData.starter_custom_minutes != null) {
      return String(agencyData.starter_custom_minutes);
    }
    if (planName === "Pro" && agencyData.pro_custom_minutes != null) {
      return String(agencyData.pro_custom_minutes);
    }
    if (planName === "Ultra" && agencyData.ultra_custom_minutes != null) {
      return String(agencyData.ultra_custom_minutes);
    }
    return byModel(planName, defaultMinutes);
  };

  const getPlanPrice = (planName: string, defaultPrice: string, defaultMinutesStr: string) => {
    if (planName === "Enterprise") return "custom";
    if (!agencyData) return defaultPrice;
    
    if (planName === "Starter" && agencyData.starter_custom_price != null) {
      return `$${Number(agencyData.starter_custom_price)}`;
    }
    if (planName === "Pro" && agencyData.pro_custom_price != null) {
      return `$${Number(agencyData.pro_custom_price)}`;
    }
    if (planName === "Ultra" && agencyData.ultra_custom_price != null) {
      return `$${Number(agencyData.ultra_custom_price)}`;
    }

    const minutes = Number(getPlanMinutes(planName, defaultMinutesStr));
    if (isNaN(minutes)) return defaultPrice;
    const computedPrice = minutes * agencyData.client_rate_per_minute;
    return computedPrice % 1 === 0 ? `$${computedPrice}` : `$${computedPrice.toFixed(2)}`;
  };

  const purchasePlan = async (plan: (typeof plans)[number]) => {
    if (!user) {
      toast({ title: "Sign in required", description: "Please sign in before starting payment.", variant: "destructive" });
      return;
    }
    // Users of an agency pay through the agency's own checkout (set by the agency).
    if (agencyData && !plan.enterprise) {
      setSelectedPlan(plan);
      
      let activeCheckoutUrl = "";
      if (plan.name === "Starter") {
        activeCheckoutUrl = agencyData.checkout_url_starter?.trim() || "";
      } else if (plan.name === "Pro") {
        activeCheckoutUrl = agencyData.checkout_url_pro?.trim() || "";
      } else if (plan.name === "Ultra") {
        activeCheckoutUrl = agencyData.checkout_url_ultra?.trim() || "";
      }
      
      if (!activeCheckoutUrl) {
        activeCheckoutUrl = agencyData.custom_checkout_url?.trim() || "";
      }

      if (activeCheckoutUrl) {
        setPurchasingPlan(plan.name);
        try {
          toast({
            title: "Continue to payment",
            description: `Redirecting to payment managed by your agency.`,
          });
          const separator = activeCheckoutUrl.includes("?") ? "&" : "?";
          const url = `${activeCheckoutUrl}${separator}email=${encodeURIComponent(user.email ?? "")}&plan=${encodeURIComponent(plan.name)}`;
          if (typeof window !== "undefined") {
            window.open(url, "_self", "noopener,noreferrer");
          }
        } catch (error) {
          toast({ title: "Error", description: error instanceof Error ? error.message : "Unable to start payment.", variant: "destructive" });
        } finally {
          setPurchasingPlan(null);
        }
      } else {
        setInstructionModalOpen(true);
      }
      return;
    }

    emailPlanRequest(plan, user.email ?? "");
  };

  const handleSendRequest = async () => {
    if (!selectedPlan) return;
    setRequesting(true);
    try {
      await requestEnterprisePlan();
      setInstructionModalOpen(false);
    } finally {
      setRequesting(false);
    }
  };

  return (
    <>
      <div className="space-y-6 animate-rise-in">
        <div className="flex flex-col gap-2 md:flex-row md:items-start md:justify-between">
          <div className={embedded ? "sr-only" : undefined}>
            <h1 className="text-3xl font-bold tracking-tight">Pricing</h1>
            <p className="mt-1 text-muted-foreground">
              Simple pricing. No hidden fees. Minutes never expire.
            </p>
          </div>
          {agencyData && (
            <Badge variant="outline" className="h-fit py-1.5 px-3 border-primary/20 bg-primary/5 text-primary text-xs font-semibold rounded-xl">
              Billing managed by agency: {agencyData.email}
            </Badge>
          )}
        </div>

        <div className="space-y-4">
          <h2 className={embedded ? "text-lg font-medium tracking-tight" : "text-2xl font-semibold tracking-tight"}>AI Calling Minutes</h2>
          <p className="text-sm text-muted-foreground">
            {contributor
              ? "Minutes on Muse Spark 1.3 Contributor ($0.10 a minute)."
              : "Minutes on Muse Spark 1.3 ($0.13 a minute). Switch to Muse Spark 1.3 Contributor in Voice model for more minutes."}
          </p>
          <div className={embedded ? "grid gap-4 sm:grid-cols-2" : "grid gap-6 xl:grid-cols-4 md:grid-cols-2"}>
            {plans.map((plan) => (
              <Card
                key={plan.name}
                className={plan.featured ? "relative overflow-hidden border-primary/50 shadow-md shadow-primary/10" : "relative overflow-hidden"}
              >
                {plan.featured ? (
                  <Badge className="absolute right-4 top-4 rounded-full bg-primary px-3 py-1 text-primary-foreground hover:bg-primary">
                    Popular
                  </Badge>
                ) : null}
                <CardHeader className="space-y-4 pb-3">
                  <div className="space-y-2">
                    <CardTitle className="text-2xl">{plan.name}</CardTitle>
                    <CardDescription className="min-h-[52px] text-base leading-relaxed">
                      {plan.description}
                    </CardDescription>
                  </div>
                  <div className="space-y-1 pt-1">
                    <div className="text-4xl font-bold tracking-tight text-foreground">
                      {getPlanPrice(plan.name, plan.price, plan.minutes)}
                    </div>
                    <p className="text-sm text-muted-foreground">one-time payment</p>
                  </div>
                </CardHeader>
                <CardContent className="space-y-6">
                  <div className="rounded-xl bg-muted/40 px-6 py-5 text-center animate-rise-in">
                    <div className="text-3xl font-bold text-foreground">{getPlanMinutes(plan.name, plan.minutes)}</div>
                    <div className="text-lg text-muted-foreground">minutes</div>
                  </div>

                  <div className="space-y-3">
                    {features.map((feature) => (
                      <div key={feature} className="flex items-center gap-3 text-sm md:text-base">
                        <Check className="h-5 w-5 text-primary" />
                        <span>{feature}</span>
                      </div>
                    ))}
                  </div>

                  <Button
                    className={plan.featured ? "w-full bg-primary text-primary-foreground hover:bg-primary/90" : "w-full border-primary/20 text-primary hover:bg-primary/5 hover:text-primary"}
                    variant={plan.featured ? "default" : "outline"}
                    size="lg"
                    onClick={() => void purchasePlan(plan)}
                  >
                    {purchasingPlan === plan.name ? "Processing..." : agencyData && !plan.enterprise ? "Buy Now" : "Request plan"}
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        </div>

        <p className="mx-auto max-w-3xl text-center text-sm md:text-base text-muted-foreground">
          All packages are one-time purchases and minutes never expire. Click a plan to email us, and we'll send you
          the details and add the minutes to your account.
        </p>
      </div>

      <Dialog open={instructionModalOpen} onOpenChange={setInstructionModalOpen}>
        <DialogContent className="sm:max-w-md border border-primary/20 bg-card/95 backdrop-blur-md">
          <DialogHeader>
            <DialogTitle className="text-xl font-bold flex items-center gap-2">
              <Timer className="h-5 w-5 text-primary" />
              Purchase Calling Minutes
            </DialogTitle>
            <DialogDescription className="text-sm text-muted-foreground mt-1">
              Your referring agency handles billing. Please follow their payment instructions below to purchase calling minutes.
            </DialogDescription>
          </DialogHeader>
          <div className="space-y-4 py-4">
            <div className="rounded-xl bg-muted/40 p-4 border border-border">
              <div className="flex justify-between items-center border-b border-border pb-2.5 mb-2.5">
                <span className="text-sm text-muted-foreground font-medium">Selected Package</span>
                <span className="text-base font-bold text-foreground">{selectedPlan?.name} ({selectedPlan ? getPlanMinutes(selectedPlan.name, selectedPlan.minutes) : ""} minutes)</span>
              </div>
              <div className="flex justify-between items-center">
                <span className="text-sm text-muted-foreground font-medium">Computed Price</span>
                <span className="text-lg font-bold text-primary">
                  {selectedPlan ? getPlanPrice(selectedPlan.name, selectedPlan.price, selectedPlan.minutes) : ""}
                </span>
              </div>
            </div>

            {agencyData?.payment_instruction ? (
              <div className="space-y-2">
                <span className="text-xs font-bold uppercase tracking-wider text-muted-foreground">Instructions from your agency</span>
                <div className="rounded-xl border border-primary/10 bg-primary/5 p-4 text-sm text-foreground whitespace-pre-line leading-relaxed font-medium">
                  {agencyData.payment_instruction}
                </div>
              </div>
            ) : (
              <p className="text-sm text-muted-foreground leading-relaxed">
                Please contact your agency administrator directly at <span className="font-semibold text-foreground">{agencyData?.email}</span> to buy minutes and credit your balance.
              </p>
            )}
          </div>
          <DialogFooter className="flex flex-col sm:flex-row gap-2 sm:gap-0">
            <Button variant="outline" onClick={() => setInstructionModalOpen(false)} className="w-full sm:w-auto">
              Close
            </Button>
            <Button onClick={() => void handleSendRequest()} disabled={requesting} className="w-full sm:w-auto">
              {requesting ? "Sending Request..." : "Request Balance Allocation"}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  );
}
