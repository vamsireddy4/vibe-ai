import { SignIn, SignUp, useAuth as useClerkAuth } from "@clerk/clerk-react";
import { Navigate, useLocation } from "react-router-dom";
import HeroTitle from "@/components/HeroTitle";
import BrandLogo from "@/components/BrandLogo";

// Hides Clerk's orange "Development mode" note (it also goes away with production keys).
// "Secured by Clerk" stays: removing it is a Clerk paid-plan setting, not something to hide in code.
// The card fills its column up to Clerk's usual 400px, so it shrinks on narrow phones instead of overflowing.
const appearance = {
  layout: { unsafe_disableDevelopmentModeWarnings: true },
  elements: { rootBox: "w-full max-w-[400px]", cardBox: "w-full max-w-full" },
};

// Sign in / sign up. Tablet and desktop: brand left, form right. Phone (too narrow for two columns): brand on top, same left-aligned look.
// Sizes are fluid (clamp + vw), so text and spacing scale with the screen instead of jumping.
export default function Auth() {
  const isSignup = useLocation().pathname.startsWith("/signup");
  const { isSignedIn } = useClerkAuth();
  const redirect = "/dashboard";
  // Already signed in (e.g. "Continue with Google" on Sign up with an existing account): go to the account.
  if (isSignedIn) return <Navigate to={redirect} replace />;

  return (
    <div className="flex min-h-[100dvh] flex-col justify-center bg-background md:grid md:grid-cols-2">
      <div className="flex justify-center px-6 pb-[2vh] pt-[6vh] md:items-center md:justify-start md:border-r md:border-border md:bg-card md:px-[6%] md:py-0">
        <div className="w-full max-w-[400px] md:max-w-full">
          <BrandLogo className="mb-[clamp(1rem,3vh,3rem)] block h-[clamp(1.5rem,2.2vw,2rem)]" />
          <h1 className="text-[clamp(1.875rem,8vw,3rem)] font-semibold leading-[1.05] tracking-[-0.03em] md:text-[clamp(2rem,4.2vw,4rem)]">
            <span className="sr-only">Every call answered. Every meeting booked.</span>
            <HeroTitle />
          </h1>
          <p className="mt-[clamp(0.75rem,2vh,1.5rem)] max-w-[46ch] text-[clamp(0.95rem,1.1vw+0.6rem,1.125rem)] leading-relaxed text-muted-foreground">
            An AI receptionist that answers your calls, books appointments, and follows up by text, WhatsApp and email.
          </p>
        </div>
      </div>
      <div className="flex justify-center px-4 pb-[6vh] pt-[2vh] md:items-center md:px-[4%] md:py-[4vh]">
        {isSignup ? (
          <SignUp routing="path" path="/signup" signInUrl="/login" forceRedirectUrl={redirect} appearance={appearance} />
        ) : (
          <SignIn routing="path" path="/login" signUpUrl="/signup" forceRedirectUrl={redirect} appearance={appearance} />
        )}
      </div>
    </div>
  );
}
