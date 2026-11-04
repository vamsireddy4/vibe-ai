import { useEffect, useState } from "react";
import { useAuth } from "@/hooks/useAuth";
import { useUser } from "@clerk/clerk-react";
import { supabase } from "@/integrations/supabase/client";
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { useToast } from "@/hooks/use-toast";
import { Eye, EyeOff } from "lucide-react";
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";




/** A settings group: a card on the Settings page; in the account window (flat) the same row layout as Profile. */
const Block = ({ flat, title, hint, children }: { flat: boolean; title: string; hint: string; children: React.ReactNode }) =>
  flat ? (
    <section className="grid gap-4 border-t py-6 sm:grid-cols-[minmax(0,1fr)_minmax(0,22rem)] sm:gap-8">
      <div className="min-w-0">
        <h3 className="text-base text-foreground">{title}</h3>
        <p className="mt-1 text-sm leading-relaxed text-muted-foreground">{hint}</p>
      </div>
      <div className="min-w-0">{children}</div>
    </section>
  ) : (
    <Card>
      <CardHeader>
        <CardTitle>{title}</CardTitle>
        <CardDescription>{hint}</CardDescription>
      </CardHeader>
      <CardContent>{children}</CardContent>
    </Card>
  );

/** Timezones offered for the account (booking times and business hours follow it). */
export const TIMEZONES: [string, string][] = [
  ["UTC", "UTC (Coordinated Universal Time)"],
  ["America/New_York", "America/New_York (US Eastern Time)"],
  ["America/Chicago", "America/Chicago (US Central Time)"],
  ["America/Denver", "America/Denver (US Mountain Time)"],
  ["America/Los_Angeles", "America/Los_Angeles (US Pacific Time)"],
  ["Europe/London", "Europe/London (London / GMT)"],
  ["Europe/Paris", "Europe/Paris (Central European Time)"],
  ["Asia/Kolkata", "Asia/Kolkata (India Standard Time)"],
  ["Asia/Singapore", "Asia/Singapore (Singapore Time)"],
  ["Asia/Tokyo", "Asia/Tokyo (Japan Standard Time)"],
  ["Australia/Sydney", "Australia/Sydney (Australian Eastern Time)"],
];

/** Account settings content. Used by the Settings page and the account window (embedded: no page title). */
/** hideProfile: the account window shows name, company and timezone itself, so it skips the Profile card. */
export default function AccountSettings({ embedded = false, hideProfile = false }: { embedded?: boolean; hideProfile?: boolean }) {

  const { user, refreshProfile } = useAuth();
  const { toast } = useToast();
  const [profileLoading, setProfileLoading] = useState(false);
  const [form, setForm] = useState({ 
    full_name: "", 
    company_name: "", 
    timezone: "UTC"
  });

  type ProfileFields = { full_name?: string; company_name?: string; timezone?: string };

  /** Read/write the user's own profiles row directly (RLS: only their row). */
  const saveProfileFields = async (payload: ProfileFields) => {
    if (!user) throw new Error("User not found");
    const { error } = await supabase.from("profiles").update(payload as never).eq("user_id", user.id);
    if (error) throw new Error(error.message || "Failed to save profile");
  };

  // Password change state
  const [newPassword, setNewPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [passwordLoading, setPasswordLoading] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [showConfirm, setShowConfirm] = useState(false);

  // Check if user signed in with email/password
  // Login is Clerk: passwords live there, not in Supabase Auth.
  const { user: clerkUser } = useUser();
  const isPasswordUser = clerkUser?.passwordEnabled ?? false;



  useEffect(() => {
    if (!user) return;
    const applyProfile = (data: any) => {
      if (!data) return;
      setForm({
        full_name: data.full_name || "",
        company_name: data.company_name || "",
        timezone: data.timezone || "UTC",
      });
    };

    supabase
      .from("profiles")
      .select("*")
      .eq("user_id", user.id)
      .maybeSingle()
      .then(({ data }) => applyProfile(data));
  }, [user]);

  const handleProfileSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!user) return;
    setProfileLoading(true);

    try {
      await saveProfileFields({
        full_name: form.full_name,
        company_name: form.company_name,
        timezone: form.timezone,
      });
      toast({ title: "Profile saved" });
      await refreshProfile();
    } catch (error: any) {
      toast({ title: "Error", description: error.message, variant: "destructive" });
    } finally {
      setProfileLoading(false);
    }
  };


  const handlePasswordChange = async (e: React.FormEvent) => {
    e.preventDefault();
    if (newPassword.length < 8) {
      toast({ title: "Error", description: "Password must be at least 8 characters.", variant: "destructive" });
      return;
    }
    if (newPassword !== confirmPassword) {
      toast({ title: "Error", description: "Passwords do not match.", variant: "destructive" });
      return;
    }
    if (!clerkUser) return;
    setPasswordLoading(true);
    const error = await clerkUser.updatePassword({ newPassword, signOutOfOtherSessions: false }).then(() => null, (e: any) => e);
    setPasswordLoading(false);
    if (error) {
      toast({ title: "Error", description: error?.errors?.[0]?.longMessage || error?.message || "Could not update the password.", variant: "destructive" });
    } else {
      toast({ title: "Password updated successfully" });
      setNewPassword("");
      setConfirmPassword("");
    }
  };

  return (
      <div className={hideProfile ? "" : "space-y-6 animate-rise-in"}>
        {!embedded && (
          <div>
            <h1 className="text-3xl font-bold tracking-tight">Settings</h1>
            <p className="text-muted-foreground mt-1">Manage your account settings.</p>
          </div>
        )}

        {!hideProfile && <Card>
          <CardHeader>
            <CardTitle>Profile</CardTitle>
          </CardHeader>
          <CardContent>
            <form onSubmit={handleProfileSubmit} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="account-email">Email</Label>
                <Input id="account-email" value={user?.email || ""} disabled />
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-full-name">Full Name</Label>
                <Input
                  id="account-full-name"
                  value={form.full_name}
                  onChange={(e) => setForm({ ...form, full_name: e.target.value })}
                  placeholder="Your name"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-user-id">User ID</Label>
                <Input id="account-user-id" value={user?.id || ""} disabled />
                <p className="text-xs text-muted-foreground">
                  Your unique account ID.
                </p>
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-company-name">Company Name</Label>
                <Input
                  id="account-company-name"
                  value={form.company_name}
                  onChange={(e) => setForm({ ...form, company_name: e.target.value })}
                  placeholder="Your company"
                />
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-timezone">Timezone</Label>
                <Select
                  value={form.timezone}
                  onValueChange={(value) => setForm({ ...form, timezone: value })}
                >
                  <SelectTrigger id="account-timezone">
                    <SelectValue placeholder="Select timezone" />
                  </SelectTrigger>
                  <SelectContent>
                    {TIMEZONES.map(([v, l]) => <SelectItem key={v} value={v}>{l}</SelectItem>)}
                  </SelectContent>
                </Select>
                <p className="text-xs text-muted-foreground">
                  The primary timezone for your voice agents to follow.
                </p>
              </div>
              <Button type="submit" disabled={profileLoading}>
                {profileLoading ? "Saving..." : "Save Profile"}
              </Button>
            </form>
          </CardContent>
        </Card>}

        <Block
          flat={hideProfile}
          title="Password"
          hint={isPasswordUser ? "Update your account password." : "Set a password to sign in with email as well as Google."}
        >
            <form onSubmit={handlePasswordChange} className="space-y-4">
              <div className="space-y-2">
                <Label htmlFor="account-new-password">New Password</Label>
                <div className="relative">
                  <Input
                    id="account-new-password"
                    type={showNew ? "text" : "password"}
                    value={newPassword}
                    onChange={(e) => setNewPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowNew(!showNew)}
                    aria-label={showNew ? "Hide new password" : "Show new password"}
                  >
                    {showNew ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <div className="space-y-2">
                <Label htmlFor="account-confirm-password">Confirm New Password</Label>
                <div className="relative">
                  <Input
                    id="account-confirm-password"
                    type={showConfirm ? "text" : "password"}
                    value={confirmPassword}
                    onChange={(e) => setConfirmPassword(e.target.value)}
                    placeholder="••••••••"
                    required
                    minLength={6}
                  />
                  <button
                    type="button"
                    className="absolute right-3 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground"
                    onClick={() => setShowConfirm(!showConfirm)}
                    aria-label={showConfirm ? "Hide confirm password" : "Show confirm password"}
                  >
                    {showConfirm ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </div>
              <Button type="submit" disabled={passwordLoading}>
                {passwordLoading ? "Updating..." : isPasswordUser ? "Update Password" : "Set Password"}
              </Button>
            </form>
        </Block>
      </div>
  );
}
