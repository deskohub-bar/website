"use client";

import { Menu, MenuContent, MenuItem, MenuTrigger } from "@ui-sdk/react/menu";
import { track } from "@vercel/analytics";
import { Languages } from "lucide-react";
import { usePathname, useRouter } from "next/navigation";
import { type Locale, locales, m, setLocale } from "@/features/i18n";
import { setLocaleInPathname } from "@/features/i18n/utils/locale-url";
import { useLocale } from "@/features/i18n/utils/use-locale";
import { Button } from "@/shared/components/ui/button";
import { cn } from "@/shared/utils";

export function LanguageSwitcher({
  triggerClassName,
}: {
  triggerClassName?: string;
}) {
  const router = useRouter();
  const pathname = usePathname();
  const currentLocale = useLocale();

  const handleLanguageChange = (newLocale: Locale) => {
    track("Language Switch", {
      from: currentLocale,
      to: newLocale,
    });
    const newPath = setLocaleInPathname(pathname, newLocale);
    setLocale(newLocale, { reload: false });
    document.documentElement.lang = newLocale;
    router.replace(newPath, { scroll: false });
    router.refresh(); // Clear the router cache to ensure all preloaded routes use the new locale
  };

  return (
    <Menu modal loop={false}>
      <MenuTrigger
        render={
          <Button
            variant="ghost"
            size="sm"
            className={cn(
              "text-white hover:text-green-400 hover:bg-white/10",
              triggerClassName
            )}
          />
        }
      >
        <Languages className="h-4 w-4 mr-2" />
        {m.language({})}
      </MenuTrigger>
      <MenuContent
        align="end"
        sideOffset={4}
        collisionPadding={0}
        onKeyDown={(event) => {
          if (event.key === "Tab") event.preventDefault();
        }}
        className="z-50 min-w-[8rem] overflow-hidden rounded-md border bg-popover p-1 text-popover-foreground shadow-md origin-[--transform-origin] transition-[opacity,transform] data-[starting-style]:opacity-0 data-[ending-style]:opacity-0 data-[starting-style]:scale-95 data-[ending-style]:scale-95"
      >
        {locales.map((locale) => (
          <MenuItem
            key={locale}
            value={locale}
            onSelect={() => handleLanguageChange(locale)}
            className={cn(
              "relative flex cursor-default select-none items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none transition-colors data-[highlighted]:bg-accent data-[highlighted]:text-accent-foreground",
              currentLocale === locale && "bg-accent"
            )}
          >
            {m.language({}, { locale })}
          </MenuItem>
        ))}
      </MenuContent>
    </Menu>
  );
}
