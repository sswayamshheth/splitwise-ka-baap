"use client";
import React from 'react';

export default function Expenses() {
  return (
    <>
<header className="fixed top-0 w-full z-50 bg-surface/85 backdrop-blur-xl shadow-[0_1px_8px_rgba(16,32,28,0.03)] pt-safe"><div className="flex items-center justify-between px-margin h-16"><div className="flex items-center gap-space-sm"><span className="material-symbols-outlined text-[28px] text-primary">explore</span><div className="flex flex-col"><span className="font-label-sm text-label-sm text-primary uppercase tracking-wider">GroupTrip</span><h1 className="font-headline-sm text-headline-sm tracking-tight text-on-surface leading-none">Monsoon Escape</h1></div></div><div className="flex items-center gap-space-sm"><button aria-label="Aisha Profile" className="w-11 h-11 flex items-center justify-center rounded-full hover:bg-surface-variant transition-colors ring-2 ring-primary/20"><img alt="Aisha" className="w-8 h-8 rounded-full object-cover" src="https://lh3.googleusercontent.com/aida-public/AB6AXuCyd6CeleLXsnMPJQvTeAdsUAgcZvlE_zS_krlY_TiqhmILU8Q7AlkZWu58uK72rwgcytazmYYBoSECIJlWsbKYp8wNErglOTpr58hG2Khv7qGkwq_imJVb0Ix7iN3op-Rc8jcKQtuastrnD6nVNgtjTkiYKZNpz2LoRAWzjAxmkPdYlfIwkWCCCg8eAt9Ur2qxWMkPymvGjT0s2cCTIvEHj_ed-87l3vBVDy1875IaH1O-TNOEcN8mmQ"/></button></div></div></header><main className="flex-1 w-full bg-surface pt-16 pb-28"><div className="flex flex-col w-full px-margin pb-6">
{/*  Sub-navigation Tabs  */}
<div className="flex items-center justify-between gap-space-xs py-space-sm mb-space-md">
<button className="px-space-md py-1.5 rounded-full font-label-md text-label-md text-on-surface-variant hover:text-on-surface transition-colors" type="button">
      Pool
    </button>
<button className="px-space-md py-1.5 rounded-full bg-primary-container text-on-primary font-label-md text-label-md shadow-sm" type="button">
      Expenses
    </button>
<button className="px-space-md py-1.5 rounded-full font-label-md text-label-md text-on-surface-variant hover:text-on-surface transition-colors" type="button">
      Budget
    </button>
<button className="px-space-md py-1.5 rounded-full font-label-md text-label-md text-on-surface-variant hover:text-on-surface transition-colors" type="button">
      Settle
    </button>
</div>
{/*  Top Ledger Summary Card  */}
<div className="relative overflow-hidden rounded-xl bg-surface-container-lowest p-space-lg shadow-sm mb-space-lg">
<div className="flex items-start justify-between">
<div className="flex flex-col gap-1">
<span className="font-label-sm text-label-sm text-on-surface-variant uppercase tracking-wider">Shared Ledger</span>
<div className="flex items-baseline gap-1.5 mt-0.5">
<span className="font-currency-display text-currency-display text-on-surface tracking-tight">₹38,400</span>
<span className="font-label-md text-label-md text-on-surface-variant">total logged</span>
</div>
</div>
<div className="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center text-primary-container">
<span className="material-symbols-outlined text-[22px]">receipt_long</span>
</div>
</div>
{/*  Alert / Notice Pill  */}
<div className="mt-space-md pt-space-sm flex items-center justify-between bg-tertiary-fixed/60 rounded-lg px-3 py-2 text-on-tertiary-fixed">
<div className="flex items-center gap-2">
<span className="material-symbols-outlined text-[18px] text-tertiary">pause_circle</span>
<span className="font-label-md text-label-md">1 transaction on hold</span>
</div>
<span className="font-label-sm text-label-sm font-semibold tracking-wide text-tertiary">₹3,600 FROZEN</span>
</div>
</div>
{/*  Timeline Ledger  */}
<div className="flex flex-col gap-space-lg">
{/*  Day 2 Section  */}
<div className="flex flex-col">
{/*  Day Sticky-style Header  */}
<div className="flex items-center justify-between pb-space-xs mb-space-sm">
<div className="flex items-center gap-2">
<span className="font-title-md text-title-md text-on-surface">Day 2</span>
<span className="w-1 h-1 rounded-full bg-outline-variant"></span>
<span className="font-label-md text-label-md text-on-surface-variant">Today (13 Sep)</span>
</div>
<span className="font-label-sm text-label-sm text-on-surface-variant">3 entries</span>
</div>
<div className="flex flex-col gap-space-sm">
{/*  Entry 1: Regular Expense  */}
<div className="flex items-start justify-between bg-surface-container-lowest p-space-md rounded-xl shadow-sm">
<div className="flex min-w-0 items-start gap-space-sm">
<div className="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center text-primary-container shrink-0">
<span className="material-symbols-outlined text-[20px]">restaurant</span>
</div>
<div className="flex flex-col min-w-0">
<h2 className="font-title-md text-title-md text-on-surface truncate">Malnad Forest Bistro &amp; Grill</h2>
<p className="font-body-md text-body-md text-on-surface-variant text-[13px] mt-0.5">Split 5 ways (Dinner) · 8:45 PM</p>
<div className="flex items-center gap-1.5 mt-2">
<span className="w-2 h-2 rounded-full bg-primary"></span>
<span className="font-label-sm text-label-sm text-primary">Aisha paid</span>
</div>
</div>
</div>
<div className="text-right shrink-0 pl-2">
<span className="font-currency-md text-currency-md text-on-surface">₹2,400</span>
<span className="block font-label-sm text-label-sm text-on-surface-variant mt-0.5">₹480 / person</span>
</div>
</div>
{/*  Entry 2: FROZEN / DISPUTED ITEM  */}
<div className="relative overflow-hidden bg-tertiary-fixed rounded-xl p-space-md shadow-sm">
<div className="flex min-w-0 items-start gap-space-sm">
<div className="w-10 h-10 rounded-full bg-tertiary-container text-on-tertiary flex items-center justify-center shrink-0">
<span className="material-symbols-outlined text-[20px]">pause</span>
</div>
<div className="flex flex-col min-w-0 flex-1">
<div className="flex items-center justify-between">
<h2 className="font-title-md text-title-md text-on-tertiary-fixed truncate">Airport cab</h2>
<span className="font-currency-md text-currency-md text-on-tertiary-fixed shrink-0 pl-2">₹3,600</span>
</div>
{/*  Frozen Tag  */}
<div className="inline-flex items-center gap-1.5 mt-1 self-start px-2 py-0.5 rounded-full bg-tertiary-container/20 text-on-tertiary-fixed font-label-sm text-label-sm">
<span className="w-1.5 h-1.5 rounded-full bg-secondary-container"></span>
                Under review · Held in the pool
              </div>
{/*  Context Details  */}
<p className="font-body-md text-body-md text-on-tertiary-fixed-variant text-[13px] mt-2 leading-relaxed">
                Billed to 5 travellers · Flagged by Rohan (<span className="italic">“Only 3 took cab from airport”</span>)
              </p>
{/*  Dispute Action CTA  */}
<button className="inline-flex items-center gap-1 mt-3 font-label-md text-label-md text-on-tertiary-fixed font-semibold hover:opacity-80 transition-opacity" type="button">
<span>Open dispute thread</span>
<span className="material-symbols-outlined text-[16px]">arrow_forward</span>
</button>
</div>
</div>
</div>
{/*  Entry 3: Regular Expense  */}
<div className="flex items-start justify-between bg-surface-container-lowest p-space-md rounded-xl shadow-sm">
<div className="flex min-w-0 items-start gap-space-sm">
<div className="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center text-primary-container shrink-0">
<span className="material-symbols-outlined text-[20px]">kayaking</span>
</div>
<div className="flex flex-col min-w-0">
<h2 className="font-title-md text-title-md text-on-surface truncate">Kali Rapids River Rafting</h2>
<p className="font-body-md text-body-md text-on-surface-variant text-[13px] mt-0.5">5 travellers · 11:30 AM</p>
<div className="flex items-center gap-1.5 mt-2">
<span className="material-symbols-outlined text-[14px] text-secondary">verified</span>
<span className="font-label-sm text-label-sm text-secondary">Escrow auto-disbursed</span>
</div>
</div>
</div>
<div className="text-right shrink-0 pl-2">
<span className="font-currency-md text-currency-md text-on-surface">₹7,000</span>
<span className="block font-label-sm text-label-sm text-on-surface-variant mt-0.5">₹1,400 / person</span>
</div>
</div>
</div>
</div>
{/*  Day 1 Section  */}
<div className="flex flex-col">
<div className="flex items-center justify-between pb-space-xs mb-space-sm">
<div className="flex items-center gap-2">
<span className="font-title-md text-title-md text-on-surface">Day 1</span>
<span className="w-1 h-1 rounded-full bg-outline-variant"></span>
<span className="font-label-md text-label-md text-on-surface-variant">12 Sep</span>
</div>
<span className="font-label-sm text-label-sm text-on-surface-variant">2 entries</span>
</div>
<div className="flex flex-col gap-space-sm">
{/*  Entry 4: FASTag Tolls  */}
<div className="flex items-start justify-between bg-surface-container-lowest p-space-md rounded-xl shadow-sm">
<div className="flex min-w-0 items-start gap-space-sm">
<div className="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center text-primary-container shrink-0">
<span className="material-symbols-outlined text-[20px]">local_gas_station</span>
</div>
<div className="flex flex-col min-w-0">
<h2 className="font-title-md text-title-md text-on-surface truncate">Highway Tolls &amp; Fuel</h2>
<p className="font-body-md text-body-md text-on-surface-variant text-[13px] mt-0.5">5 travellers · Hubli Express Route</p>
<div className="flex items-center gap-1.5 mt-2">
<span className="w-2 h-2 rounded-full bg-primary"></span>
<span className="font-label-sm text-label-sm text-primary">Amit paid via FASTag</span>
</div>
</div>
</div>
<div className="text-right shrink-0 pl-2">
<span className="font-currency-md text-currency-md text-on-surface">₹1,840</span>
<span className="block font-label-sm text-label-sm text-on-surface-variant mt-0.5">₹368 / person</span>
</div>
</div>
{/*  Entry 5: Chalets Advance  */}
<div className="flex items-start justify-between bg-surface-container-lowest p-space-md rounded-xl shadow-sm">
<div className="flex min-w-0 items-start gap-space-sm">
<div className="w-10 h-10 rounded-full bg-surface-container flex items-center justify-center text-primary-container shrink-0">
<span className="material-symbols-outlined text-[20px]">cottage</span>
</div>
<div className="flex flex-col min-w-0">
<h2 className="font-title-md text-title-md text-on-surface truncate">The Fern Riverfront Chalets (Advance)</h2>
<p className="font-body-md text-body-md text-on-surface-variant text-[13px] mt-0.5">All 3 nights · Verified stay</p>
<div className="flex items-center gap-1.5 mt-2">
<span className="material-symbols-outlined text-[14px] text-primary">account_balance</span>
<span className="font-label-sm text-label-sm text-primary">Direct Escrow Vault</span>
</div>
</div>
</div>
<div className="text-right shrink-0 pl-2">
<span className="font-currency-md text-currency-md text-on-surface">₹24,000</span>
<span className="block font-label-sm text-label-sm text-on-surface-variant mt-0.5">₹4,800 / person</span>
</div>
</div>
</div>
</div>
</div>
{/*  Reassurance & Escrow Security Banner  */}
<div className="mt-space-xl p-space-md bg-surface-container-low rounded-xl flex items-start gap-space-sm">
<span className="material-symbols-outlined text-[20px] text-primary mt-0.5 shrink-0">shield</span>
<p className="font-body-md text-body-md text-on-surface-variant text-[13px] leading-relaxed">
      Vendor payments continue uninterrupted. Frozen amount <span className="font-semibold text-on-surface">₹3,600</span> remains securely held in escrow until all members agree.
    </p>
</div>
</div></main><nav className="fixed bottom-0 w-full z-50 pb-safe bg-surface/85 backdrop-blur-xl shadow-[0_-2px_12px_rgba(16,32,28,0.04)]" data-active-classes="text-primary font-semibold"><div className="flex items-center justify-around h-20 px-space-xs"><a className="flex flex-col items-center justify-center min-w-[56px] min-h-[44px] gap-space-xs text-on-surface-variant hover:text-on-surface transition-colors" data-path="trip" href="#"><span className="material-symbols-outlined text-[24px]">landscape</span><span className="font-label-md text-label-md">Trip</span></a><a className="flex flex-col items-center justify-center min-w-[56px] min-h-[44px] gap-space-xs text-on-surface-variant hover:text-on-surface transition-colors" data-path="itinerary" href="#"><span className="material-symbols-outlined text-[24px]">calendar_today</span><span className="font-label-md text-label-md">Itinerary</span></a><div className="flex items-center justify-center min-w-[56px] min-h-[44px] -mt-5"><a className="w-12 h-12 rounded-full bg-primary-container text-on-primary flex items-center justify-center shadow-[0_8px_20px_rgba(30,111,100,0.35)] hover:bg-primary transition-all duration-200 active:scale-95" data-path="add-expense" href="#"><span className="material-symbols-outlined text-[28px]">add</span></a></div><a className="flex flex-col items-center justify-center min-w-[56px] min-h-[44px] gap-space-xs text-on-surface-variant hover:text-on-surface transition-colors" data-path="pool" href="#"><span className="material-symbols-outlined text-[24px]">account_balance_wallet</span><span className="font-label-md text-label-md">Money</span></a><a className="flex flex-col items-center justify-center min-w-[56px] min-h-[44px] gap-space-xs text-on-surface-variant hover:text-on-surface transition-colors" data-path="group" href="#"><span className="material-symbols-outlined text-[24px]">group</span><span className="font-label-md text-label-md">Group</span></a></div></nav>
</>
  );
}
