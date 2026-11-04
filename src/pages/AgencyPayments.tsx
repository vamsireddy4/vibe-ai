import DashboardLayout from "@/components/DashboardLayout";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Button } from "@/components/ui/button";
import { Timer } from "lucide-react";
import { useToast } from "@/hooks/use-toast";
import { supabase } from "@/integrations/supabase/client";
import { useAuth } from "@/hooks/useAuth";
import { useEffect, useState } from "react";

export default function AgencyPayments() {
  const { toast } = useToast();
  const { user } = useAuth();
  const [clientRate, setClientRate] = useState<string>("0.15");
  const [wholesaleRate, setWholesaleRate] = useState<number>(0.10);
  const [checkoutUrlStarter, setCheckoutUrlStarter] = useState<string>("");
  const [checkoutUrlPro, setCheckoutUrlPro] = useState<string>("");
  const [checkoutUrlUltra, setCheckoutUrlUltra] = useState<string>("");
  
  const [starterCustomMinutes, setStarterCustomMinutes] = useState<string>("190");
  const [starterCustomPrice, setStarterCustomPrice] = useState<string>("19.00");
  const [proCustomMinutes, setProCustomMinutes] = useState<string>("500");
  const [proCustomPrice, setProCustomPrice] = useState<string>("49.00");
  const [ultraCustomMinutes, setUltraCustomMinutes] = useState<string>("1500");
  const [ultraCustomPrice, setUltraCustomPrice] = useState<string>("149.00");
  
  const [paymentInstruction, setPaymentInstruction] = useState<string>("");
  const [updatingSettings, setUpdatingSettings] = useState(false);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    if (!user?.email) return;

    const loadSettings = async () => {
      setLoading(true);
      try {
        const { data, error } = await supabase
          .from("agency_access_grants")
          .select("client_rate_per_minute, wholesale_rate_per_minute, checkout_url_starter, checkout_url_pro, checkout_url_ultra, payment_instruction, starter_custom_minutes, starter_custom_price, pro_custom_minutes, pro_custom_price, ultra_custom_minutes, ultra_custom_price")
          .eq("email", user.email.toLowerCase().trim())
          .maybeSingle();

        if (!error && data) {
          const currentClientRate = data.client_rate_per_minute != null ? data.client_rate_per_minute : 0.15;
          setClientRate(String(currentClientRate));
          setWholesaleRate(data.wholesale_rate_per_minute ?? 0.10);
          setCheckoutUrlStarter(data.checkout_url_starter ?? "");
          setCheckoutUrlPro(data.checkout_url_pro ?? "");
          setCheckoutUrlUltra(data.checkout_url_ultra ?? "");
          
          const sMins = data.starter_custom_minutes != null ? data.starter_custom_minutes : 190;
          setStarterCustomMinutes(String(sMins));
          setStarterCustomPrice(
            data.starter_custom_price != null
              ? String(data.starter_custom_price)
              : (sMins * currentClientRate).toFixed(2)
          );
          
          const pMins = data.pro_custom_minutes != null ? data.pro_custom_minutes : 500;
          setProCustomMinutes(String(pMins));
          setProCustomPrice(
            data.pro_custom_price != null
              ? String(data.pro_custom_price)
              : (pMins * currentClientRate).toFixed(2)
          );
          
          const uMins = data.ultra_custom_minutes != null ? data.ultra_custom_minutes : 1500;
          setUltraCustomMinutes(String(uMins));
          setUltraCustomPrice(
            data.ultra_custom_price != null
              ? String(data.ultra_custom_price)
              : (uMins * currentClientRate).toFixed(2)
          );
          
          setPaymentInstruction(data.payment_instruction ?? "");
        }
      } catch (err) {
        console.error("Failed to load settings:", err);
      } finally {
        setLoading(false);
      }
    };

    void loadSettings();
  }, [user]);

  const saveAgencySettings = async () => {
    if (!user?.email) return;
    const rate = Number(clientRate);
    if (isNaN(rate) || rate <= 0) {
      toast({
        title: "Error",
        description: "Please enter a valid positive per-minute rate.",
        variant: "destructive",
      });
      return;
    }

    const sMins = Number(starterCustomMinutes);
    const sPrice = Number(starterCustomPrice);
    const pMins = Number(proCustomMinutes);
    const pPrice = Number(proCustomPrice);
    const uMins = Number(ultraCustomMinutes);
    const uPrice = Number(ultraCustomPrice);

    if (!Number.isInteger(sMins) || sMins <= 0 || !Number.isInteger(pMins) || pMins <= 0 || !Number.isInteger(uMins) || uMins <= 0) {
      toast({
        title: "Error",
        description: "Please enter positive whole integer values for package minutes.",
        variant: "destructive",
      });
      return;
    }

    if (isNaN(sPrice) || sPrice <= 0 || isNaN(pPrice) || pPrice <= 0 || isNaN(uPrice) || uPrice <= 0) {
      toast({
        title: "Error",
        description: "Please enter valid positive price values for pricing packages.",
        variant: "destructive",
      });
      return;
    }

    const sRate = sPrice / sMins;
    const pRate = pPrice / pMins;
    const uRate = uPrice / uMins;

    if (sRate < wholesaleRate || pRate < wholesaleRate || uRate < wholesaleRate) {
      toast({
        title: "Error",
        description: `One or more custom packages have an effective rate below your wholesale cost ($${wholesaleRate}/min). Please increase your package price or reduce its minutes.`,
        variant: "destructive",
      });
      return;
    }

    setUpdatingSettings(true);
    try {
      const { error } = await supabase
        .from("agency_access_grants")
        .update({
          client_rate_per_minute: rate,
          checkout_url_starter: checkoutUrlStarter.trim() || null,
          checkout_url_pro: checkoutUrlPro.trim() || null,
          checkout_url_ultra: checkoutUrlUltra.trim() || null,
          starter_custom_minutes: sMins,
          starter_custom_price: sPrice,
          pro_custom_minutes: pMins,
          pro_custom_price: pPrice,
          ultra_custom_minutes: uMins,
          ultra_custom_price: uPrice,
          payment_instruction: paymentInstruction.trim() || null,
          updated_at: new Date().toISOString(),
        })
        .eq("email", user.email.toLowerCase().trim());

      if (error) throw error;
      toast({ title: "Success", description: "Agency pricing & billing settings updated successfully!" });
    } catch (err) {
      toast({
        title: "Error",
        description: err instanceof Error ? err.message : "Failed to update settings.",
        variant: "destructive",
      });
    } finally {
      setUpdatingSettings(false);
    }
  };

  const handleClientRateChange = (newRateStr: string) => {
    setClientRate(newRateStr);
    const rate = Number(newRateStr);
    if (!isNaN(rate) && rate > 0) {
      const sMins = Number(starterCustomMinutes);
      if (!isNaN(sMins) && sMins > 0) {
        setStarterCustomPrice((sMins * rate).toFixed(2));
      }
      const pMins = Number(proCustomMinutes);
      if (!isNaN(pMins) && pMins > 0) {
        setProCustomPrice((pMins * rate).toFixed(2));
      }
      const uMins = Number(ultraCustomMinutes);
      if (!isNaN(uMins) && uMins > 0) {
        setUltraCustomPrice((uMins * rate).toFixed(2));
      }
    }
  };

  const handleStarterMinutesChange = (newMinsStr: string) => {
    setStarterCustomMinutes(newMinsStr);
    const mins = Number(newMinsStr);
    const rate = Number(clientRate);
    if (!isNaN(mins) && mins > 0 && !isNaN(rate) && rate > 0) {
      setStarterCustomPrice((mins * rate).toFixed(2));
    }
  };

  const handleProMinutesChange = (newMinsStr: string) => {
    setProCustomMinutes(newMinsStr);
    const mins = Number(newMinsStr);
    const rate = Number(clientRate);
    if (!isNaN(mins) && mins > 0 && !isNaN(rate) && rate > 0) {
      setProCustomPrice((mins * rate).toFixed(2));
    }
  };

  const handleUltraMinutesChange = (newMinsStr: string) => {
    setUltraCustomMinutes(newMinsStr);
    const mins = Number(newMinsStr);
    const rate = Number(clientRate);
    if (!isNaN(mins) && mins > 0 && !isNaN(rate) && rate > 0) {
      setUltraCustomPrice((mins * rate).toFixed(2));
    }
  };

  return (
    <DashboardLayout>
      <div className="space-y-6 animate-rise-in">
        <div>
          <h1 className="text-3xl font-bold tracking-tight">Agency Payments</h1>
          <p className="mt-1 text-muted-foreground">
            Manage your client pricing structures, checkout integrations, and payment rules.
          </p>
        </div>

        {loading ? (
          <p className="text-sm text-muted-foreground">Loading settings...</p>
        ) : (
          <Card className="border border-primary/20 bg-primary/5 backdrop-blur-md shadow-lg">
            <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-4">
              <div className="space-y-1.5">
                <CardTitle className="flex items-center gap-2 text-xl font-bold">
                  <Timer className="h-5 w-5 text-primary" />
                  Agency Client Billing & Pricing Settings
                </CardTitle>
                <CardDescription>
                  Configure the retail pricing and checkout flow that your referred clients see on their Pricing page.
                </CardDescription>
              </div>
            </CardHeader>
            <CardContent>
              <div className="grid gap-6 md:grid-cols-2 items-start">
                <div className="space-y-6">
                  <div className="space-y-2">
                    <Label htmlFor="client-rate" className="text-sm font-semibold flex items-center gap-1.5">
                      Client Price per Minute ($)
                    </Label>
                    <Input
                      id="client-rate"
                      type="number"
                      min="0.01"
                      step="0.01"
                      value={clientRate}
                      onChange={(e) => handleClientRateChange(e.target.value)}
                      placeholder="0.15"
                      className="bg-background border-primary/10 font-medium"
                    />
                    <p className="text-xs text-muted-foreground">
                      Clients will see Starter/Pro/Ultra plans calculated at this rate (e.g. 190 min @ $0.15 = $28.50). Must be at least your wholesale cost of ${wholesaleRate.toFixed(2)}/min.
                    </p>
                  </div>

                  <div className="space-y-2">
                    <Label htmlFor="payment-instruction" className="text-sm font-semibold flex items-center gap-1.5">
                      Manual Payment Instructions
                    </Label>
                    <textarea
                      id="payment-instruction"
                      rows={4}
                      value={paymentInstruction}
                      onChange={(e) => setPaymentInstruction(e.target.value)}
                      placeholder="Please contact billing@agency.com or transfer via Zelle to billing@agency.com to buy calling minutes."
                      className="w-full rounded-lg border border-primary/10 bg-background px-3 py-2 text-sm shadow-sm ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 min-h-[100px] resize-y"
                    />
                    <p className="text-xs text-muted-foreground">
                      Shown in a popup if no package-specific checkout link is configured, or as additional instructions.
                    </p>
                  </div>
                </div>

                <div className="space-y-6 rounded-xl border border-primary/15 bg-primary/5 p-5">
                  <div className="space-y-1">
                    <h3 className="text-base font-bold text-foreground">Custom Package Settings</h3>
                    <p className="text-xs text-muted-foreground">
                      Configure custom calling minutes, pricing, and Stripe links for your referred clients.
                    </p>
                  </div>
                  
                  <div className="space-y-5">
                    {/* Starter Package */}
                    <div className="space-y-3 rounded-lg border border-primary/10 bg-background/50 p-3.5 animate-rise-in">
                      <h4 className="text-sm font-bold text-primary">Starter Plan</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="starter-minutes" className="text-xs font-semibold">Starter Minutes</Label>
                          <Input
                            id="starter-minutes"
                            type="number"
                            value={starterCustomMinutes}
                            onChange={(e) => handleStarterMinutesChange(e.target.value)}
                            placeholder="190"
                            className="bg-background border-primary/10 text-sm h-8"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="starter-price" className="text-xs font-semibold">Starter Price ($)</Label>
                          <Input
                            id="starter-price"
                            type="number"
                            step="0.01"
                            value={starterCustomPrice}
                            onChange={(e) => setStarterCustomPrice(e.target.value)}
                            placeholder="19.00"
                            className="bg-background border-primary/10 text-sm h-8"
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="checkout-starter" className="text-xs font-semibold text-muted-foreground">
                          Stripe Checkout URL
                        </Label>
                        <Input
                          id="checkout-starter"
                          type="text"
                          value={checkoutUrlStarter}
                          onChange={(e) => setCheckoutUrlStarter(e.target.value)}
                          placeholder="https://buy.stripe.com/starter-plan"
                          className="bg-background border-primary/10 text-sm h-8"
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Effective rate: ${(Number(starterCustomPrice) / Math.max(1, Number(starterCustomMinutes))).toFixed(3)}/min
                      </p>
                    </div>

                    {/* Pro Package */}
                    <div className="space-y-3 rounded-lg border border-primary/10 bg-background/50 p-3.5 animate-rise-in">
                      <h4 className="text-sm font-bold text-primary">Pro Plan (Most Popular)</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="pro-minutes" className="text-xs font-semibold">Pro Minutes</Label>
                          <Input
                            id="pro-minutes"
                            type="number"
                            value={proCustomMinutes}
                            onChange={(e) => handleProMinutesChange(e.target.value)}
                            placeholder="500"
                            className="bg-background border-primary/10 text-sm h-8"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="pro-price" className="text-xs font-semibold">Pro Price ($)</Label>
                          <Input
                            id="pro-price"
                            type="number"
                            step="0.01"
                            value={proCustomPrice}
                            onChange={(e) => setProCustomPrice(e.target.value)}
                            placeholder="49.00"
                            className="bg-background border-primary/10 text-sm h-8"
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="checkout-pro" className="text-xs font-semibold text-muted-foreground">
                          Stripe Checkout URL
                        </Label>
                        <Input
                          id="checkout-pro"
                          type="text"
                          value={checkoutUrlPro}
                          onChange={(e) => setCheckoutUrlPro(e.target.value)}
                          placeholder="https://buy.stripe.com/pro-plan"
                          className="bg-background border-primary/10 text-sm h-8"
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Effective rate: ${(Number(proCustomPrice) / Math.max(1, Number(proCustomMinutes))).toFixed(3)}/min
                      </p>
                    </div>

                    {/* Ultra Package */}
                    <div className="space-y-3 rounded-lg border border-primary/10 bg-background/50 p-3.5 animate-rise-in">
                      <h4 className="text-sm font-bold text-primary">Ultra Plan</h4>
                      <div className="grid grid-cols-2 gap-3">
                        <div className="space-y-1">
                          <Label htmlFor="ultra-minutes" className="text-xs font-semibold">Ultra Minutes</Label>
                          <Input
                            id="ultra-minutes"
                            type="number"
                            value={ultraCustomMinutes}
                            onChange={(e) => handleUltraMinutesChange(e.target.value)}
                            placeholder="1500"
                            className="bg-background border-primary/10 text-sm h-8"
                          />
                        </div>
                        <div className="space-y-1">
                          <Label htmlFor="ultra-price" className="text-xs font-semibold">Ultra Price ($)</Label>
                          <Input
                            id="ultra-price"
                            type="number"
                            step="0.01"
                            value={ultraCustomPrice}
                            onChange={(e) => setUltraCustomPrice(e.target.value)}
                            placeholder="149.00"
                            className="bg-background border-primary/10 text-sm h-8"
                          />
                        </div>
                      </div>
                      <div className="space-y-1">
                        <Label htmlFor="checkout-ultra" className="text-xs font-semibold text-muted-foreground">
                          Stripe Checkout URL
                        </Label>
                        <Input
                          id="checkout-ultra"
                          type="text"
                          value={checkoutUrlUltra}
                          onChange={(e) => setCheckoutUrlUltra(e.target.value)}
                          placeholder="https://buy.stripe.com/ultra-plan"
                          className="bg-background border-primary/10 text-sm h-8"
                        />
                      </div>
                      <p className="text-[10px] text-muted-foreground">
                        Effective rate: ${(Number(ultraCustomPrice) / Math.max(1, Number(ultraCustomMinutes))).toFixed(3)}/min
                      </p>
                    </div>
                  </div>
                </div>
              </div>
              <div className="mt-4 flex justify-end">
                <Button onClick={() => void saveAgencySettings()} disabled={updatingSettings} size="sm">
                  {updatingSettings ? "Saving Settings..." : "Save Pricing Settings"}
                </Button>
              </div>
            </CardContent>
          </Card>
        )}
      </div>
    </DashboardLayout>
  );
}
