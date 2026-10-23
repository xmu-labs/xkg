import type { Metadata } from "next";
import Link from "next/link";
import LegalPage from "@/components/LegalPage";

export const metadata: Metadata = { title: "Terms of Service · xkg" };

export default function TermsPage() {
  return (
    <LegalPage title="Terms of Service">
      <p>
        By signing in to xkg.xmu.sh you agree to these Terms and to the{" "}
        <Link href="/privacy">Privacy Policy</Link>. xkg is operated by SPV Technology Inc., 1111B S
        Governors Ave, STE 34689, Dover, DE 19904, United States.
      </p>

      <h2>1. The service and your account</h2>
      <p>
        xkg captures what you read into a knowledge repository in your own GitHub account, and lets
        AI tools you connect search and apply it.
      </p>
      <ul>
        <li>You sign in with GitHub. Your xkg account exists as long as that GitHub account is linked to it.</li>
        <li>You must be at least 16 and able to accept these Terms where you live, and you must follow GitHub&apos;s terms.</li>
        <li>
          Your account is for you. Keep your GitHub account, PIN and xkg API key secure. Anything done
          with them counts as done by you.
        </li>
        <li>
          If you think a key or PIN is exposed, generate a new xkg API key in Settings. That revokes
          every other session and every connected AI worker at once.
        </li>
      </ul>

      <h2>2. Your content and your keys</h2>
      <p>
        You own what you capture. You give xkg only the permission it needs to run the service for
        you.
      </p>
      <ul>
        <li>
          <strong>Ownership.</strong> Captures, and anything else you put into xkg, stay yours. They
          are stored in your GitHub repository, not by xkg.
        </li>
        <li>
          <strong>Permission to operate.</strong> You let xkg read, process, transform and write your
          content solely to provide the service. That includes sending it to your LLM provider and to
          AI tools you connect. The permission ends when you delete your account.
        </li>
        <li>
          <strong>Your LLM account.</strong> xkg uses your own API key, so your provider bills you
          directly and its terms apply to that use. xkg limits captures per hour to cap what a leaked
          key can spend, but you are responsible for your provider costs.
        </li>
        <li>
          <strong>Connected AI workers.</strong> Tools you connect act with your authority: they can
          read, add, update, archive and delete content in your knowledge repository through xkg.
        </li>
        <li>
          <strong>Your responsibility.</strong> You have the right to capture and store what you
          submit. AI-generated output, such as extracted insights, briefings and plans, can be wrong.
          Check it before relying on it.
        </li>
      </ul>

      <h2>3. Acceptable use</h2>
      <p>Use xkg for your own knowledge work, lawfully. Don&apos;t:</p>
      <ul>
        <li>Capture or store content you have no right to, or content that is illegal.</li>
        <li>Use xkg&apos;s page fetching to probe, overload or attack websites or internal networks.</li>
        <li>Get around rate limits, lockouts or other security measures, or access another person&apos;s account or data.</li>
        <li>Upload malware, or interfere with the service or its infrastructure.</li>
        <li>Resell or offer the hosted service to others as your own.</li>
      </ul>
      <p>
        Security research is welcome when reported privately under the{" "}
        <a href="https://github.com/xmu-labs/xkg/security/policy">security policy</a>.
      </p>

      <h2>4. Open-source code, fees and availability</h2>
      <ul>
        <li>
          <strong>The code is open; these Terms cover the hosted service.</strong> xkg&apos;s source is
          available under the <a href="https://github.com/xmu-labs/xkg/blob/main/LICENSE">MIT licence</a>.
          These Terms apply only to the service at xkg.xmu.sh. If you run your own copy, you operate it
          under the MIT licence and these Terms don&apos;t apply to it.
        </li>
        <li>
          <strong>Name and logo.</strong> The MIT licence does not cover the xkg name or logo.
          Don&apos;t present your own copy or product as xkg.
        </li>
        <li>
          <strong>Fees.</strong> The hosted service is currently free; you pay your own LLM provider.
          If we introduce paid features, we&apos;ll give at least 30 days&apos; notice, and nothing
          you&apos;re using will start costing you money without your agreement.
        </li>
        <li>
          <strong>Availability.</strong> xkg is provided on a best-effort basis, without an uptime
          guarantee. We may change or stop features, or the service. If we shut it down, we&apos;ll
          give at least 30 days&apos; notice; your captures remain in your GitHub repository
          regardless.
        </li>
      </ul>

      <h2>5. Disclaimers, liability and ending the agreement</h2>
      <ul>
        <li>
          <strong>As is.</strong> xkg is provided &ldquo;as is&rdquo; and &ldquo;as available&rdquo;,
          without warranties of any kind, to the extent the law allows. That includes accuracy of AI
          output, fitness for a purpose, and uninterrupted operation.
        </li>
        <li>
          <strong>Limit of liability.</strong> To the extent the law allows, we are not liable for
          indirect, incidental or consequential losses, or lost data or profits. Our total liability is
          capped at the greater of the amounts you paid us in the 12 months before the claim, or
          US$100. Nothing here limits liability that cannot be limited by law, such as for fraud.
        </li>
        <li>
          <strong>Third parties.</strong> We are not responsible for GitHub, your LLM provider, AI
          tools you connect, or websites you capture. Their own terms govern them.
        </li>
        <li>
          <strong>Ending it.</strong> You can stop using xkg at any time and delete your account in
          Settings (<Link href="/privacy">Privacy Policy</Link>, section 3). We may suspend or close an
          account that breaks section 3 of these Terms or puts others at risk, with notice where
          reasonable.
        </li>
        <li>
          <strong>Governing law.</strong> These Terms are governed by the laws of the State of
          Delaware, USA, and disputes go to the state or federal courts in Delaware. Consumers keep the
          protections of their local law, including the right to bring a claim in their own courts.
        </li>
        <li>
          <strong>Changes.</strong> We&apos;ll post updated Terms here and tell you in the app before
          material changes take effect. Continuing to use xkg after that means you accept them.
        </li>
        <li>
          <strong>Contact.</strong> <a href="mailto:sofia@spvtechnology.com">sofia@spvtechnology.com</a>.
        </li>
      </ul>
    </LegalPage>
  );
}
