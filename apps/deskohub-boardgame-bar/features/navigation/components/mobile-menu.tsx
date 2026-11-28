"use client";

import {
  Dialog,
  DialogBackdrop,
  DialogClose,
  DialogContent,
  DialogTitle,
  DialogTrigger,
} from "@ui-sdk/react/dialog";
import { Menu, X } from "lucide-react";
import Image from "next/image";
import { useState } from "react";
import logoImage from "@/assets/images/logo/for-dark-bg.png";
import { LanguageSwitcher, LocalizedLink, m, setLocale } from "@/features/i18n";
import { useLocale } from "@/features/i18n/utils/use-locale";
import { Button } from "@/shared/components/ui/button";
import { siteConstants } from "@/shared/utils/constants";
import {
  getWeekdayHours,
  getWeekendHours,
} from "@/shared/utils/working-hours-helpers";
import { ReservationButton } from "./reservation-button";

const navigationItems = [
  { label: "nav.home", href: "/", text: () => m["nav.home"]() },
  {
    label: "nav.boardGames",
    href: "/board-games",
    text: () => m["nav.boardGames"](),
  },
  { label: "nav.gallery", href: "/gallery", text: () => m["nav.gallery"]() },
  { label: "nav.menu", href: "/menu", text: () => m["nav.menu"]() },
  { label: "nav.contact", href: "/contact", text: () => m["nav.contact"]() },
];

export function MobileMenu() {
  const [isOpen, setIsOpen] = useState(false);
  const locale = useLocale();
  const ttrpgRoomHref = `https://workspace.deskohub.cz/${locale}/ttrpg-room`;
  setLocale(locale, { reload: false });

  return (
    <Dialog open={isOpen} onOpenChange={setIsOpen}>
      <DialogTrigger
        render={
          <Button
            variant="ghost"
            size="icon"
            className="text-white hover:text-white hover:bg-white/10 xl:hidden"
          />
        }
      >
        <Menu className="h-6 w-6" />
        <span className="sr-only">{m["nav.openMenu"]()}</span>
      </DialogTrigger>
      <DialogBackdrop className="fixed inset-0 bg-black/80 transition-opacity data-[starting-style]:opacity-0 data-[ending-style]:opacity-0" />
      <DialogContent className="fixed inset-y-0 right-0 left-auto m-0 h-full max-h-none w-80 max-w-full gap-4 border-l border-gray-800 bg-gray-900 p-6 text-foreground shadow-lg safe-padding-vertical transition-transform duration-500 ease-in-out data-[starting-style]:translate-x-full data-[ending-style]:translate-x-full data-[ending-style]:duration-300">
        <div className="flex flex-col space-y-2 border-b border-gray-800 pb-4 text-center sm:text-left">
          <div className="flex items-center gap-3">
            <Image
              src={logoImage}
              alt={m["altText.deskohub"]()}
              width={40}
              height={40}
              className="rounded-lg"
              priority
            />
            <DialogTitle className="text-white text-lg font-bold">
              {siteConstants.brand.name}
            </DialogTitle>
          </div>
        </div>

        <nav className="flex flex-col gap-2 mt-6">
          {navigationItems.map((item) => (
            <LocalizedLink
              key={item.label}
              href={item.href}
              className="flex items-center px-4 py-3 text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors duration-200 font-medium"
              onClick={() => setIsOpen(false)}
            >
              {item.text()}
            </LocalizedLink>
          ))}
          <a
            href={ttrpgRoomHref}
            className="flex items-center px-4 py-3 text-gray-300 hover:text-white hover:bg-gray-800 rounded-lg transition-colors duration-200 font-medium"
            onClick={() => setIsOpen(false)}
          >
            {m["nav.trainingRoom"]()}
          </a>
        </nav>

        <div className="mt-8 space-y-4">
          <div className="px-4 py-3 bg-gray-800 rounded-lg">
            <h3 className="text-white font-semibold mb-2">
              {m["menu.openingHours.title"]()}
            </h3>
            <div className="text-sm text-gray-300 space-y-1">
              <div className="flex justify-between">
                <span>{m["menu.openingHours.weekdays"]()}</span>
                <span className="text-green-400">
                  {m["menu.openingHours.weekdaysTime"]({
                    hours: getWeekdayHours().formatted,
                  })}
                </span>
              </div>
              <div className="flex justify-between">
                <span>{m["menu.openingHours.weekend"]()}</span>
                <span className="text-green-400">
                  {m["menu.openingHours.weekendTime"]({
                    hours: getWeekendHours().formatted,
                  })}
                </span>
              </div>
            </div>
          </div>

          <div className="px-4">
            <LanguageSwitcher />
          </div>

          <div className="px-4">
            <ReservationButton
              variant="full"
              showIcon={true}
              onClick={() => setIsOpen(false)}
            />
          </div>
        </div>

        <div className="absolute bottom-6 left-6 right-6">
          <div className="text-center text-xs text-gray-500">
            <p>{m["footer.tagline"]()}</p>
          </div>
        </div>
        <DialogClose className="absolute right-4 top-4 rounded-sm bg-secondary text-white opacity-70 ring-offset-background transition-opacity hover:opacity-100 focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2">
          <X className="h-4 w-4" />
          <span className="sr-only">Close</span>
        </DialogClose>
      </DialogContent>
    </Dialog>
  );
}
