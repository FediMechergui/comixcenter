import Link from "next/link";
export default function PrivacyPage() {
  return <div className="stack-lg"><h1 className="title">Your data and sources</h1><div className="prose stack">
    <p>Your imported comics, reading progress and guide checklists stay on this device. There is no ComixCenter account or automatic cloud backup. Uninstalling the app can remove local data; save a personal backup and keep copies of your comic files.</p>
    <h2>Online requests</h2><p>The hosted gateway receives comic searches, metadata requests and the network information needed to answer them, including your IP address. Hosting infrastructure can retain request logs. ComixCenter has no advertising or analytics SDK.</p>
    <h2>Source reader</h2><p>Online source websites load directly in a separate in-app browser and receive your IP address and browser requests. They control their own content, cookies, advertisements and privacy policies. Source cookies remain on the phone and are not transferred to Vercel. ComixCenter cannot guarantee source availability.</p>
    <h2>Credentials and backups</h2><p>Shared metadata credentials stay on the gateway. Accounts you enter in Settings stay on this device. Personal backups contain your catalog and reading activity, but exclude credentials, source cookies and comic bytes. Keep backups somewhere private.</p>
    <h2>Content and attribution</h2><p>Import comics you have the right to read. Listing a third-party source does not grant redistribution rights. Catalog information comes from Metron, Comic Vine and the Grand Comics Database; GCD data is licensed under CC BY-SA 4.0.</p>
    <Link className="text-link" href="/settings">Back to Settings</Link>
  </div></div>;
}
