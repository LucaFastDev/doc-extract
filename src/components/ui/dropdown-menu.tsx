'use client'

import * as React from 'react'
import { DropdownMenu as DropdownMenuPrimitive } from 'radix-ui'
import { CircleIcon } from 'lucide-react'

import { cn } from '@/lib/utils'

// The menu's own button, so its content can tell a press on that button from a press anywhere else.
const TriggerContext = React.createContext<React.RefObject<HTMLButtonElement | null> | null>(null)

function DropdownMenu({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Root>) {
  const trigger = React.useRef<HTMLButtonElement>(null)
  return (
    <TriggerContext.Provider value={trigger}>
      <DropdownMenuPrimitive.Root data-slot="dropdown-menu" {...props} />
    </TriggerContext.Provider>
  )
}

// With asChild, a ref on the child is kept alongside this one.
function DropdownMenuTrigger({ ...props }: Omit<React.ComponentProps<typeof DropdownMenuPrimitive.Trigger>, 'ref'>) {
  const trigger = React.useContext(TriggerContext)
  return <DropdownMenuPrimitive.Trigger ref={trigger} data-slot="dropdown-menu-trigger" {...props} />
}

function DropdownMenuContent({
  className,
  sideOffset = 4,
  onKeyDownCapture,
  onClickCapture,
  onAuxClickCapture,
  onInteractOutside,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Content>) {
  const trigger = React.useContext(TriggerContext)

  // A closed menu stays on the page until its exit animation ends, and focus stays on its item until
  // then, so a key that selects would run an item the user has just cancelled (issue #100). Stopped
  // here, before the item's own handler, for every menu. Prevented too, so a link item is not followed.
  function ignoreSelectionKeysWhileClosing(event: React.KeyboardEvent<HTMLDivElement>) {
    onKeyDownCapture?.(event)
    if (event.currentTarget.dataset.state === 'closed' && (event.key === 'Enter' || event.key === ' ')) {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  // The same for the pointer (issue #102). An item runs only from a click, including the click its own
  // pointer up sends, and the browser opens a link item in a new tab only from the auxclick a middle
  // press sends, so stopping those two is enough; the menu goes on closing as if never pressed.
  function ignorePressWhileClosing(event: React.MouseEvent<HTMLDivElement>) {
    if (event.currentTarget.dataset.state === 'closed') {
      event.preventDefault()
      event.stopPropagation()
    }
  }

  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        className={cn(
          'z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-[8rem] origin-(--radix-dropdown-menu-content-transform-origin) overflow-x-hidden overflow-y-auto rounded-md border bg-popover p-1 text-popover-foreground shadow-md data-[side=bottom]:slide-in-from-top-2 data-[side=left]:slide-in-from-right-2 data-[side=right]:slide-in-from-left-2 data-[side=top]:slide-in-from-bottom-2 data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=closed]:zoom-out-95 data-[state=open]:animate-in data-[state=open]:fade-in-0 data-[state=open]:zoom-in-95',
          className,
        )}
        {...props}
        onKeyDownCapture={ignoreSelectionKeysWhileClosing}
        onClickCapture={(event) => {
          onClickCapture?.(event)
          ignorePressWhileClosing(event)
        }}
        onAuxClickCapture={(event) => {
          onAuxClickCapture?.(event)
          ignorePressWhileClosing(event)
        }}
        // A press the button toggles the menu on, a plain left press, is not outside the menu, and
        // neither is focus landing on the button. Without this, such a press while a closing menu is
        // still animating out closes the menu it has just reopened, and so does the closed menu's late
        // hand-off of focus to the button, if the press came just after that menu left the page
        // (issues #97, #102). Any other press on the button, such as a right click or a Ctrl-click,
        // does not toggle, so it stays outside and dismisses the menu.
        onInteractOutside={(event) => {
          onInteractOutside?.(event)
          const { originalEvent } = event.detail
          const inside = originalEvent instanceof FocusEvent || (originalEvent.button === 0 && !originalEvent.ctrlKey)
          if (inside && trigger?.current?.contains(originalEvent.target as Node)) event.preventDefault()
        }}
      />
    </DropdownMenuPrimitive.Portal>
  )
}

function DropdownMenuItem({
  className,
  inset,
  variant = 'default',
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Item> & {
  inset?: boolean
  variant?: 'default' | 'destructive'
}) {
  return (
    <DropdownMenuPrimitive.Item
      data-slot="dropdown-menu-item"
      data-inset={inset}
      data-variant={variant}
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[inset]:pl-8 data-[variant=destructive]:text-destructive data-[variant=destructive]:focus:bg-destructive/10 data-[variant=destructive]:focus:text-destructive [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4 [&_svg:not([class*='text-'])]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  )
}

function DropdownMenuRadioGroup({ ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.RadioGroup>) {
  return <DropdownMenuPrimitive.RadioGroup data-slot="dropdown-menu-radio-group" {...props} />
}

function DropdownMenuRadioItem({
  className,
  children,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.RadioItem>) {
  return (
    <DropdownMenuPrimitive.RadioItem
      data-slot="dropdown-menu-radio-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm py-1.5 pr-2 pl-8 text-sm outline-hidden select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
        className,
      )}
      {...props}
    >
      <span className="pointer-events-none absolute left-2 flex size-3.5 items-center justify-center">
        <DropdownMenuPrimitive.ItemIndicator>
          <CircleIcon className="size-2 fill-current" />
        </DropdownMenuPrimitive.ItemIndicator>
      </span>
      {children}
    </DropdownMenuPrimitive.RadioItem>
  )
}

function DropdownMenuLabel({
  className,
  inset,
  ...props
}: React.ComponentProps<typeof DropdownMenuPrimitive.Label> & {
  inset?: boolean
}) {
  return (
    <DropdownMenuPrimitive.Label
      data-slot="dropdown-menu-label"
      data-inset={inset}
      className={cn('px-2 py-1.5 text-sm font-medium data-[inset]:pl-8', className)}
      {...props}
    />
  )
}

function DropdownMenuSeparator({ className, ...props }: React.ComponentProps<typeof DropdownMenuPrimitive.Separator>) {
  return (
    <DropdownMenuPrimitive.Separator
      data-slot="dropdown-menu-separator"
      className={cn('-mx-1 my-1 h-px bg-border', className)}
      {...props}
    />
  )
}

export {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
}
