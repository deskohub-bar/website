# Workspace reservation products

Workspace offers cowork, meeting room, and office reservations. Team Table is a planned reservation family. Each family has its own selection rules, availability, customer summary, and product identity. Checkout applies the rules of the selected family.

## Opening hours

The space is open 24/7, every day. Open Space is usable only from Prague-local
midnight until 17:00 on the reserved date. Reserved Desk and office
reservations have 24/7 code access for their reserved dates. An overnight
Reserved Desk stay has code access from noon on its arrival date until noon
the next day.

The public price page lists every bookable product at its catalog price, with
the price of any public sale running that day, together with these opening
hours. The contact page also shows the opening hours.

## Cowork

Cowork offers are exactly two, both booked for a single Prague date:

- **Open Space** (CZK 290/day): a shared desk available Prague-local 00:00
  until 17:00 exclusive on the reserved date. An optional coffee addon costs
  CZK 50. Open Space is never marketed as 24/7 access.
- **Reserved Desk** (CZK 410/day, coffee included): a reserved desk for the
  whole Prague calendar day (midnight to next midnight, DST-correct) with
  24/7 code access. An optional workstation addon costs CZK 120/day and is
  selectable only as one of the four existing monitor configurations; the
  chosen configuration changes availability and the reserved product
  composition, never the price. When no bare Reserved Desk is available for a
  date but at least one valid workstation configuration is available, the
  customer must reserve a workstation and choose from the available monitor
  configurations. The advertised and accepted price includes an additional
  CZK 120/day for the workstation. The customer cannot select an unavailable
  exact configuration. Reserved Desk cannot be selected when neither a bare
  desk nor any workstation configuration is available for the full calendar
  date.

### Reserved Desk stay

A Reserved Desk reservation has a **stay**: **Day** or **Overnight**. A day
stay is the whole Prague calendar day described above. An overnight stay runs
from 12:00 on the picked date, the arrival day, until 12:00 on the next day,
Prague wall-clock time, so a night across a daylight-saving change lasts 23 or
25 hours. Open Space has no overnight stay, and no stay spans more than one
night.

- An overnight stay costs the same as a Reserved Desk day, with the same
  coffee, workstation addon, discount codes, promotions and Calendar sales. The
  arrival day is its service date for every discount and sale rule.
- An overnight stay on a date is available only when one desk, bare or in the
  chosen workstation configuration, is free for the whole noon-to-noon stay,
  and neither the arrival day nor the next day is closed as fully occupied in
  the Calendar.
- Arrival days follow the usual booking horizon, so a stay that arrives on
  the last bookable day ends the day after it. Same-day booking follows the
  rule for a Reserved Desk day.
- Workspace doesn't record the stay separately: a Reserved Desk reservation
  that runs from noon to noon the next day is an overnight stay, and any other
  Reserved Desk reservation is a day stay.
- Overnight stays are released behind one switch. While it is off, no booking
  surface offers them and any request for one is refused; Day stays are
  unaffected. Customers who don't choose a stay, including those on older app
  versions, book a day stay.

Historical entry tiers (basic, plus, profi) remain decodable for stored
reservations and reporting but are no longer saleable. A whole-cowork discount
applies to the base price of both current offers, and a discount may instead
target only Open Space or only Reserved Desk; coffee and workstation addons
stay outside the discountable subtotal.

When assigning Reserved Desk, Workspace ranks tables as though every enabled,
visible, assignable Open Space table were occupied up to its configured seat
capacity. Ranking uses the greater of actual occupancy and that capacity;
actual occupancy is not added to capacity. Actual occupancy alone determines
whether the selected table has room and what public availability reports. A
table configured for both offers remains eligible for Reserved Desk whenever
its actual capacity permits.

## Meeting room

Meeting-room products are exactly:

- one hour;
- four hours; or
- one whole Prague calendar day.

A whole day runs from Prague midnight to the following Prague midnight. It remains a calendar day across daylight-saving changes and is not normalized to a fixed number of elapsed hours.

Hourly products begin at the selected local time. The selected duration remains part of the product the customer reviews and must not be inferred later from start and end timestamps.

A meeting-room reservation remains eligible for submission and payment after its start while its exclusive end is still in the future. It is no longer eligible after that end.

### Early setup

A customer booking a meeting room may choose to come 15 minutes before the booked start to set up. The choice is off by default and free. It holds the room, and lets the customer in, from 15 minutes before the booked start until the booked end. Price, discounts, cancellation, and every other time rule still apply to the booked interval alone.

The choice is offered only when a meeting room is free for the booked interval extended 15 minutes earlier. The workspace is open around the clock, so a booking that starts at midnight sets up from 23:45 on the previous day. When the room is booked just before the start, the choice stays visible but can't be selected, with a short reason, and changing to such a time or duration turns it off. Availability is checked again when the booking is submitted.

Reservations made without the choice keep their booked interval as they always have.

## Office

An office reservation spans an inclusive range of Prague calendar dates. The customer selects a start date, a positive number of days, and a positive number of seats supported by the office capacity. The office capacity is the seat count configured for the office's table in Dotypos. It is the only place the maximum is set: the booking form and its agent-readable page, the app, the customer booking API, agent tools, and the server's checks all use it, so changing the office's seats in Dotypos changes every surface without a release.

The latest included date may not be more than one calendar month after the current Prague date. An unavailable date ends the longest range that can be selected from an earlier start.

The complete Prague-midnight interval may not exceed 672 elapsed hours. This is evaluated independently of the calendar-day count: 28 selected days are normally 672 hours, are 671 hours across the spring daylight-saving transition, and are 673 hours across the autumn transition. An autumn-transition reservation is therefore limited to 27 selected days.

Office price is calculated per selected day from the daily office access price plus the daily seat price for every reserved seat. Every visible price comes from the current advertised offer rather than a separate display-only amount.

The office is exclusive for the complete selected date range. Any existing occupancy makes it unavailable, regardless of unused seat capacity.

## Team Table (planned)

A Team Table reservation gives one group exclusive use of a table for the booked interval. The group chooses a table size from the seat capacities of enabled, visible Team Tables configured in Dotypos. Workspace checks availability and assigns a table of exactly the selected size.

Starts and ends fall on Prague-local 15-minute boundaries. A booking lasts 15 minutes to 24 elapsed hours and must fit within the same usable hours as Open Space. With the current cutoff, a booking must end by 17:00 on its start date. When Open Space is available around the clock, a booking may cross midnight as long as the full interval fits the applicable hours.

The booking calendar covers six months. A customer can book for today, and can submit and pay after the start, while the exclusive end is still in the future and a table is available. The table is held from the booked start until the exclusive end. Team Table checkout offers neither early setup nor a coffee add-on.

Checkout and invoices show two price lines. The base charge is CZK 60 per seat. The time charge is CZK 20 per seat per hour, billed at CZK 5 per seat for every 15-minute slot in the booking. Both charges use the selected table size and are discountable. Public prices show the base and hourly amounts for each bookable table size.

Within 14 days of concluding the contract, a consumer can withdraw from the entire Team Table booking before its booked start and receive a full refund. The booking counts as one unit. Once it starts, the rest of the booking is ineligible for partial withdrawal.

Team Table becomes bookable when its reservation flow is complete and its release switch is on. While the switch is off, booking surfaces hide the offer and refuse new Team Table selections and bookings.

### Shared tables and reassignment

Workspace assigns Open Space bookings to tables outside the Team Table pool first. Within the Team Table pool, it fills tables already in use before assigning an empty table. An active Team Table hold or confirmed booking blocks all Open Space and Team Table use of its table for the booked interval.

For Team Table, Workspace chooses a table that needs the fewest moves. When tables need the same number of moves, it prefers one with a non-overlapping Team Table booking on a Prague date the request touches.

To make room on a future Prague date, Workspace can reassign unseated Open Space holds for paid single-day bookings, Entry Pack visits, and Unlimited Pass days. Each hold needs room at a different Open Space table for its entire reserved interval. Workspace can move several holds to free one table. Today's bookings, Reserved Desk bookings, and bookings without a matching Workspace record stay in place.

Availability includes a Team Table slot only when a table is clear or every blocker can be moved. Checkout checks live availability again and places the Team Table hold only after the moves have cleared its table. Reassignment preserves the Open Space booking, payment, and door code.

## Cross-family rules

- The customer confirmation email contains a protected link to the dedicated reservation access page, never the door PIN itself. Once an authorized paid, locally and live-confirmed reservation has an issued PIN, the access page displays it together with the exact reservation access span, including any selected early setup. Igloohome's programmed AlgoPIN bounds alone determine when the lock accepts the code; there is no local display time gate, and display never extends the reserved use of the space. Payment redirects and fulfillment recovery remain on the separate reservation status page.
- Product identity includes the reservation family and every choice that changes the purchased product.
- Discount configuration may target a whole reservation family or a single current cowork offer, while quotes and completed purchases preserve the exact selected product.
- Availability, pricing, summaries, persistence, confirmation, email, and status views dispatch each family explicitly.
- Adding a reservation family requires complete support at every issuing and consuming boundary before it becomes publicly selectable.

## Cross-family email policy

The current Open Space customer confirmation, preview, and retry emails list
all eligible named Open Space tables instead of the assigned table. Numeric
names are sorted and compacted only for consecutive runs of at least three;
pairs remain separate. Nonnumeric names follow in provider order. For example,
`9-12, 15, 16, wallee, gromice`. If no eligible named tables exist, the email
omits the table block and never falls back to an assigned table ID. Reserved
Desk, other reservation families, and historical cowork tiers retain assigned-
table email behavior.

With Team Table, Open Space confirmation, preview, and retry emails will omit
tables held by active Team Table bookings that overlap the Open Space booking's
usable interval. Active bookings include unexpired holds and confirmed bookings.
If the overlap check fails, fulfillment will retry the confirmation. Status and
on-site views will omit the list while the check is unavailable. Team Table
confirmation emails, status pages, and access pages will name the assigned table.
