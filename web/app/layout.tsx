import type { Metadata } from "next";
import { ClerkProvider } from "@clerk/nextjs";
import { FeedbackProvider } from "@/components/app/kit";
import "./globals.css";

export const metadata: Metadata = {
  title: "GroupTrip Ledger",
  description: "Group travel app where the itinerary is the ledger",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <ClerkProvider appearance={{ variables: { colorPrimary: "#1e6f64", colorText: "#0e1e1b", fontFamily: "'Plus Jakarta Sans', sans-serif", borderRadius: "12px" } }}>
    <html lang="en">
      <head>
        <link href="https://fonts.googleapis.com" rel="preconnect" />
        <link crossOrigin="" href="https://fonts.gstatic.com" rel="preconnect" />
        <link href="https://fonts.googleapis.com/css2?family=Playfair+Display:ital,wght@0,400..700;1,400..700&amp;family=Plus+Jakarta+Sans:wght@400;500;600;700&amp;display=swap" rel="stylesheet" />
        <link href="https://fonts.googleapis.com/css2?family=Material+Symbols+Outlined:opsz,wght,FILL,GRAD@20..48,100..700,0..1,-50..200" rel="stylesheet" />
      </head>
      <body className="bg-surface text-on-surface font-body-md text-body-md antialiased min-h-screen flex flex-col">
        <FeedbackProvider>{children}</FeedbackProvider>
      </body>
    </html>
    </ClerkProvider>
  );
}
