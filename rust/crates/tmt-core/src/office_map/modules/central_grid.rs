//! Public lattice independent of paired rooms. Private cells never become shortcuts.

use super::*;
use crate::office_map::{MAX_SPANS, MAX_TILES};

pub(super) fn project(
    circulation: &mut Circulation,
    rooms: &[ModuleRect],
    reserved: ModuleRect,
    compact: bool,
    bridges: bool,
) -> Result<(), MapError> {
    let left = rooms.iter().map(|rect| rect.x).min().unwrap();
    let right = rooms.iter().map(|rect| rect.right()).max().unwrap();
    let top = rooms.iter().map(|rect| rect.y).min().unwrap();
    let bottom = rooms.iter().map(|rect| rect.bottom()).max().unwrap();
    let lobby = ModuleRect {
        x: 0,
        y: 0,
        width: LOBBY_WIDTH,
        height: LOBBY_HEIGHT,
    };
    let mut tiles = rooms
        .iter()
        .map(|rect| (rect.width * rect.height) as usize)
        .sum::<usize>();
    let mut spans = rooms.iter().map(|rect| rect.height as usize).sum::<usize>();
    let mut required = Vec::new();
    if compact {
        for room in rooms.iter().filter(|room| **room != lobby) {
            if bridges {
                if let Some(rect) = direct_bridge(circulation, *room) {
                    required.push(rect);
                    continue;
                }
                if let Some(rect) = perimeter_bridge(circulation, *room, rooms) {
                    required.push(rect);
                    continue;
                }
            }
            let branch_y = if room.y < 0 {
                room.bottom()
            } else if room.y >= LOBBY_HEIGHT {
                room.y - PASSAGE_WIDTH
            } else {
                ROOM_HEIGHT
            };
            let entrance_x = room.x + (room.width - PASSAGE_WIDTH) / 2;
            if bridges {
                let north = room.y < 0;
                let south = room.y >= LOBBY_HEIGHT;
                circulation.door(
                    entrance_x,
                    if north {
                        room.bottom()
                    } else if south || room.y > 0 {
                        room.y
                    } else {
                        room.bottom()
                    },
                    Axis::Horizontal,
                );
                if north || south {
                    circulation.door(
                        ROOM_WIDTH,
                        if north { 0 } else { LOBBY_HEIGHT },
                        Axis::Horizontal,
                    );
                } else {
                    circulation.door(
                        if room.x < 0 { 0 } else { LOBBY_WIDTH },
                        ROOM_HEIGHT,
                        Axis::Vertical,
                    );
                }
            }
            required.push(ModuleRect {
                x: entrance_x.min(ROOM_WIDTH),
                y: branch_y,
                width: entrance_x.max(ROOM_WIDTH) + PASSAGE_WIDTH - entrance_x.min(ROOM_WIDTH),
                height: PASSAGE_WIDTH,
            });
            required.push(ModuleRect {
                x: ROOM_WIDTH,
                y: branch_y.min(ROOM_HEIGHT),
                width: PASSAGE_WIDTH,
                height: branch_y.max(ROOM_HEIGHT) + PASSAGE_WIDTH - branch_y.min(ROOM_HEIGHT),
            });
        }
    }
    // Generate disjoint row runs, not a dense bounding-box tile allocation. Check
    // the ordinary map budgets while expanding hostile, widely separated slots.
    for y in top..bottom {
        let runs = if compact {
            let mut intervals = required
                .iter()
                .filter(|rect| y >= rect.y && y < rect.bottom())
                .map(|rect| (rect.x, rect.right()))
                .collect::<Vec<_>>();
            intervals.sort_unstable();
            let mut merged: Vec<(i32, i32)> = Vec::new();
            for (start, end) in intervals {
                if let Some(last) = merged.last_mut().filter(|last| start <= last.1) {
                    last.1 = last.1.max(end);
                } else {
                    merged.push((start, end));
                }
            }
            merged
        } else if y.rem_euclid(ROW_STEP) >= ROOM_HEIGHT {
            vec![(left, right)]
        } else {
            (left.div_euclid(COLUMN_STEP)..=right.div_euclid(COLUMN_STEP))
                .filter_map(|column| {
                    let start = (column * COLUMN_STEP + ROOM_WIDTH).max(left);
                    let end = ((column + 1) * COLUMN_STEP).min(right);
                    (start < end).then_some((start, end))
                })
                .collect()
        };
        let mut runs = runs;
        for exclusion in [lobby, reserved] {
            if y < exclusion.y || y >= exclusion.bottom() {
                continue;
            }
            runs = runs
                .into_iter()
                .flat_map(|(start, end)| {
                    let mut remaining = Vec::with_capacity(2);
                    if start < exclusion.x {
                        remaining.push((start, end.min(exclusion.x)));
                    }
                    if end > exclusion.right() {
                        remaining.push((start.max(exclusion.right()), end));
                    }
                    remaining
                })
                .collect();
        }
        for (start, end) in runs {
            tiles += (end - start) as usize;
            spans += 1;
            if tiles > MAX_TILES || spans > MAX_SPANS {
                return Err(MapError::LimitExceeded);
            }
            circulation.rect(ModuleRect {
                x: start,
                y,
                width: end - start,
                height: 1,
            });
        }
    }
    if bridges {
        return Ok(());
    }
    // An opening depends only on adjacent public floor. No opposite room is
    // required, including the four entrances on the Lobby's central axes.
    for room in rooms {
        let x = room.x + (room.width - PASSAGE_WIDTH) / 2;
        let y = room.y + (room.height - PASSAGE_WIDTH) / 2;
        for (edge_x, outside_x) in [(room.x, room.x - 1), (room.right(), room.right())] {
            if (0..PASSAGE_WIDTH).all(|i| circulation.contains(outside_x, y + i)) {
                circulation.door(edge_x, y, Axis::Vertical);
            }
        }
        for (edge_y, outside_y) in [(room.y, room.y - 1), (room.bottom(), room.bottom())] {
            if (0..PASSAGE_WIDTH).all(|i| circulation.contains(x + i, outside_y)) {
                circulation.door(x, edge_y, Axis::Horizontal);
            }
        }
    }
    Ok(())
}

/// Share direct perimeter bridges across empty slots without incidental doors.
fn perimeter_bridge(
    circulation: &mut Circulation,
    room: ModuleRect,
    rooms: &[ModuleRect],
) -> Option<ModuleRect> {
    let neighbor = rooms
        .iter()
        .filter(|other| {
            (other.x == room.x
                && (other.right() == -PASSAGE_WIDTH || other.x == LOBBY_WIDTH + PASSAGE_WIDTH)
                && other.y >= 0
                && other.bottom() <= LOBBY_HEIGHT)
                || (other.y == room.y
                    && (other.bottom() == -PASSAGE_WIDTH
                        || other.y == LOBBY_HEIGHT + PASSAGE_WIDTH)
                    && other.x >= 0
                    && other.right() <= LOBBY_WIDTH)
        })
        .min_by_key(|other| {
            (
                other.x != room.x,
                (other.x - room.x).abs() + (other.y - room.y).abs(),
                other.y,
                other.x,
            )
        })?;
    if neighbor.x != room.x {
        let x = room.x + (room.width - PASSAGE_WIDTH) / 2;
        let target_x = neighbor.x + (neighbor.width - PASSAGE_WIDTH) / 2;
        let y = if room.y < 0 {
            -PASSAGE_WIDTH
        } else {
            LOBBY_HEIGHT
        };
        circulation.door(
            x,
            if room.y < 0 { room.bottom() } else { room.y },
            Axis::Horizontal,
        );
        return Some(ModuleRect {
            x: x.min(target_x),
            y,
            width: x.max(target_x) + PASSAGE_WIDTH - x.min(target_x),
            height: PASSAGE_WIDTH,
        });
    }
    let y = room.y + (room.height - PASSAGE_WIDTH) / 2;
    let target_y = neighbor.y + (neighbor.height - PASSAGE_WIDTH) / 2;
    let x = if room.x < 0 {
        -PASSAGE_WIDTH
    } else {
        LOBBY_WIDTH
    };
    circulation.door(
        if room.x < 0 { room.right() } else { room.x },
        y,
        Axis::Vertical,
    );
    Some(ModuleRect {
        x,
        y: y.min(target_y),
        width: PASSAGE_WIDTH,
        height: y.max(target_y) + PASSAGE_WIDTH - y.min(target_y),
    })
}

/// Neighboring pods open directly onto a short bridge; distant rooms still use
/// the public lattice so another private office never becomes their only route.
fn direct_bridge(circulation: &mut Circulation, room: ModuleRect) -> Option<ModuleRect> {
    let x = room.x + (room.width - PASSAGE_WIDTH) / 2;
    let y = room.y + (room.height - PASSAGE_WIDTH) / 2;
    let north = room.bottom() == -PASSAGE_WIDTH;
    let south = room.y == LOBBY_HEIGHT + PASSAGE_WIDTH;
    let west = room.right() == -PASSAGE_WIDTH;
    let east = room.x == LOBBY_WIDTH + PASSAGE_WIDTH;
    if (north || south) && room.x >= 0 && room.right() <= LOBBY_WIDTH {
        let edge = if north { -PASSAGE_WIDTH } else { LOBBY_HEIGHT };
        let rect = ModuleRect {
            x,
            y: edge,
            width: PASSAGE_WIDTH,
            height: PASSAGE_WIDTH,
        };
        circulation.door(x, edge, Axis::Horizontal);
        circulation.door(x, edge + PASSAGE_WIDTH, Axis::Horizontal);
        Some(rect)
    } else if (west || east) && room.y >= 0 && room.bottom() <= LOBBY_HEIGHT {
        let edge = if west { -PASSAGE_WIDTH } else { LOBBY_WIDTH };
        let rect = ModuleRect {
            x: edge,
            y,
            width: PASSAGE_WIDTH,
            height: PASSAGE_WIDTH,
        };
        circulation.door(edge, y, Axis::Vertical);
        circulation.door(edge + PASSAGE_WIDTH, y, Axis::Vertical);
        Some(rect)
    } else {
        None
    }
}
