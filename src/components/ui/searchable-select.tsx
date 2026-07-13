"use client"

import * as React from "react"
import { ChevronsUpDown } from "lucide-react"

import { Button } from "@/components/ui/button"
import {
  Command,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "@/components/ui/command"
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from "@/components/ui/popover"
import { cn } from "@/lib/utils"

export type SearchableSelectOption = {
  value: string
  label: string
  description?: string
  keywords?: string
  disabled?: boolean
}

type SearchableSelectProps = {
  id?: string
  value: string
  onValueChange: (value: string) => void
  options: SearchableSelectOption[]
  placeholder?: string
  searchPlaceholder?: string
  emptyText?: string
  ariaLabel: string
  disabled?: boolean
  className?: string
  contentClassName?: string
}

function SearchableSelect({
  id,
  value,
  onValueChange,
  options,
  placeholder = "Choose an option",
  searchPlaceholder = "Search...",
  emptyText = "No matching options.",
  ariaLabel,
  disabled = false,
  className,
  contentClassName,
}: SearchableSelectProps) {
  const [open, setOpen] = React.useState(false)
  const triggerRef = React.useRef<HTMLButtonElement>(null)
  const selected = options.find((option) => option.value === value)

  function closeFromKeyboard(event: Event) {
    event.preventDefault()
    event.stopPropagation()
    setOpen(false)
    window.requestAnimationFrame(() => triggerRef.current?.focus())
  }

  React.useEffect(() => {
    if (!disabled) return
    setOpen(false)
  }, [disabled])

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <Button
          id={id}
          ref={triggerRef}
          type="button"
          variant="outline"
          role="combobox"
          aria-label={ariaLabel}
          aria-expanded={open}
          disabled={disabled}
          className={cn("h-8 w-full justify-between bg-background px-2.5 font-normal", !selected && "text-muted-foreground", className)}
        >
          <span className="min-w-0 truncate">{selected?.label ?? placeholder}</span>
          <ChevronsUpDown className="ml-2 size-4 shrink-0 opacity-45" aria-hidden="true" />
        </Button>
      </PopoverTrigger>
      <PopoverContent
        align="start"
        className={cn("w-[var(--radix-popover-trigger-width)] min-w-64 p-0", contentClassName)}
        onEscapeKeyDown={closeFromKeyboard}
      >
        <Command>
          <CommandInput
            autoFocus
            placeholder={searchPlaceholder}
            aria-label={searchPlaceholder}
            onKeyDown={(event) => {
              if (event.key !== "Escape") return
              closeFromKeyboard(event.nativeEvent)
            }}
          />
          <CommandList>
            <CommandEmpty>{emptyText}</CommandEmpty>
            <CommandGroup>
              {options.map((option) => (
                <CommandItem
                  key={option.value}
                  value={`${option.label} ${option.keywords ?? ""} ${option.value}`}
                  disabled={option.disabled}
                  data-checked={option.value === value}
                  aria-selected={option.value === value}
                  onSelect={() => {
                    onValueChange(option.value)
                    setOpen(false)
                  }}
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate">{option.label}</span>
                    {option.description && <span className="block truncate text-xs text-muted-foreground">{option.description}</span>}
                  </span>
                </CommandItem>
              ))}
            </CommandGroup>
          </CommandList>
        </Command>
      </PopoverContent>
    </Popover>
  )
}

export { SearchableSelect }
