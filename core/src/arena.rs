//! The arena's walls and cover, in centimetres, matching the layout of
//! `prototype/style-frame.html`. The origin is the centre, x runs along the
//! 40 m side and z along the 28 m side. Everything inside is point-symmetric.

/// Half the arena's length along x.
pub const HALF_X: i32 = 2000;
/// Half the arena's width along z.
pub const HALF_Z: i32 = 1400;

/// Something that blocks crafts and bolts.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Obstacle {
    /// An axis-aligned box: centre and half extents.
    Box {
        x: i32,
        z: i32,
        half_x: i32,
        half_z: i32,
    },
    /// A round prop: centre and radius.
    Round { x: i32, z: i32, radius: i32 },
}

/// One side of the cover; the other is the same turned half a turn about the
/// centre. Prop radii are their footprints at the style frame's scale.
const HALF: [Obstacle; 10] = [
    Obstacle::Box {
        x: 1250,
        z: -150,
        half_x: 50,
        half_z: 300,
    },
    Obstacle::Box {
        x: 450,
        z: 950,
        half_x: 300,
        half_z: 50,
    },
    Obstacle::Round {
        x: 750,
        z: -550,
        radius: 120,
    }, // structure
    Obstacle::Round {
        x: 320,
        z: -880,
        radius: 80,
    }, // barrels
    Obstacle::Round {
        x: 1620,
        z: 960,
        radius: 80,
    }, // large barrel
    Obstacle::Round {
        x: 1760,
        z: 790,
        radius: 60,
    }, // small barrel
    Obstacle::Round {
        x: 950,
        z: 980,
        radius: 140,
    }, // rock
    Obstacle::Round {
        x: 1680,
        z: -1040,
        radius: 120,
    }, // rock
    Obstacle::Round {
        x: -620,
        z: 220,
        radius: 100,
    }, // generator
    Obstacle::Round {
        x: -1840,
        z: -1220,
        radius: 60,
    }, // turret
];

/// Every obstacle, in a fixed order: the centre crystal, then each side.
pub const OBSTACLES: [Obstacle; 21] = {
    // The centre is the crystal's plinth: 2.3 m in radius at its foot, as drawn.
    let mut all = [Obstacle::Round {
        x: 0,
        z: 0,
        radius: 230,
    }; 21];
    let mut i = 0;
    while i < HALF.len() {
        all[1 + 2 * i] = HALF[i];
        all[2 + 2 * i] = match HALF[i] {
            Obstacle::Box {
                x,
                z,
                half_x,
                half_z,
            } => Obstacle::Box {
                x: -x,
                z: -z,
                half_x,
                half_z,
            },
            Obstacle::Round { x, z, radius } => Obstacle::Round {
                x: -x,
                z: -z,
                radius,
            },
        };
        i += 1;
    }
    all
};

/// Where a team's crafts appear, by their place in the team. Coral spawns at
/// negative x, Violet at the mirror image.
pub fn spawn(team: crate::Team, place: usize) -> (i32, i32) {
    const CORAL: [(i32, i32); 4] = [(-1750, -200), (-1750, 200), (-1750, -600), (-1750, 600)];
    let (x, z) = CORAL[place % CORAL.len()];
    match team {
        crate::Team::Coral => (x, z),
        crate::Team::Violet => (-x, -z),
    }
}

/// Where a craft can come back after being destroyed, before the safest is
/// picked: a grid over the back of Coral's half, clear of cover by a margin.
/// Violet's are the mirror image, in the same order, so neither side's
/// choice is better.
const RESPAWN_X: [i32; 5] = [-1800, -1500, -1200, -900, -600];
const RESPAWN_Z: [i32; 7] = [-1200, -800, -400, 0, 400, 800, 1200];
/// How far a respawn point stays from cover, past the craft's own radius.
const RESPAWN_CLEARANCE: i32 = 40;
/// The step a line of sight is checked at.
const SIGHT_STEP: i32 = 20;

/// The points `team` may respawn at, in a fixed order.
pub fn respawn_points(team: crate::Team) -> impl Iterator<Item = (i32, i32)> {
    RESPAWN_X
        .into_iter()
        .flat_map(|x| RESPAWN_Z.into_iter().map(move |z| (x, z)))
        .filter(|&(x, z)| {
            let reach = crate::CRAFT_RADIUS + RESPAWN_CLEARANCE;
            x.abs() <= HALF_X - reach
                && z.abs() <= HALF_Z - reach
                && OBSTACLES.iter().all(|o| !o.touches(x, z, reach))
        })
        .map(move |(x, z)| match team {
            crate::Team::Coral => (x, z),
            crate::Team::Violet => (-x, -z),
        })
}

/// Whether nothing in the arena stands on the line from `a` to `b`.
pub fn line_of_sight(a: (i32, i32), b: (i32, i32)) -> bool {
    let (dx, dz) = (b.0 - a.0, b.1 - a.1);
    let steps = (crate::fixed::length(dx, dz) / SIGHT_STEP).max(1);
    (0..=steps).all(|i| {
        let (x, z) = (a.0 + dx * i / steps, a.1 + dz * i / steps);
        OBSTACLES.iter().all(|o| !o.touches(x, z, 1))
    })
}

impl Obstacle {
    /// The point of this obstacle closest to `(x, z)`, for a box, or its
    /// centre and radius, for a round one.
    pub(crate) fn nearest(self, x: i32, z: i32) -> ((i32, i32), i32) {
        match self {
            Obstacle::Box {
                x: cx,
                z: cz,
                half_x,
                half_z,
            } => (
                (
                    x.clamp(cx - half_x, cx + half_x),
                    z.clamp(cz - half_z, cz + half_z),
                ),
                0,
            ),
            Obstacle::Round { x, z, radius } => ((x, z), radius),
        }
    }

    /// Whether a circle of `radius` at `(x, z)` overlaps this obstacle.
    pub(crate) fn touches(self, x: i32, z: i32, radius: i32) -> bool {
        let ((nx, nz), own) = self.nearest(x, z);
        let (dx, dz) = (i64::from(x - nx), i64::from(z - nz));
        let reach = i64::from(radius + own);
        dx * dx + dz * dz < reach * reach
    }
}

#[cfg(test)]
mod tests {
    use super::{HALF_X, HALF_Z, OBSTACLES, Obstacle, line_of_sight, respawn_points, spawn};
    use crate::{CRAFT_RADIUS, Team};

    #[test]
    fn point_symmetric() {
        for pair in OBSTACLES[1..].chunks(2) {
            let mirrored = match pair[0] {
                Obstacle::Box {
                    x,
                    z,
                    half_x,
                    half_z,
                } => Obstacle::Box {
                    x: -x,
                    z: -z,
                    half_x,
                    half_z,
                },
                Obstacle::Round { x, z, radius } => Obstacle::Round {
                    x: -x,
                    z: -z,
                    radius,
                },
            };
            assert_eq!(mirrored, pair[1]);
        }
    }

    #[test]
    fn spawns_are_clear_and_inside() {
        for team in [Team::Coral, Team::Violet] {
            for place in 0..4 {
                let (x, z) = spawn(team, place);
                assert!(x.abs() <= HALF_X - CRAFT_RADIUS && z.abs() <= HALF_Z - CRAFT_RADIUS);
                assert!(
                    OBSTACLES.iter().all(|o| !o.touches(x, z, CRAFT_RADIUS)),
                    "{team:?} {place}"
                );
            }
        }
    }

    #[test]
    fn respawn_points_are_clear_mirrored_and_on_their_own_half() {
        let coral: Vec<_> = respawn_points(Team::Coral).collect();
        let violet: Vec<_> = respawn_points(Team::Violet).collect();
        assert!(coral.len() >= 20, "{}", coral.len());
        assert_eq!(
            violet,
            coral.iter().map(|&(x, z)| (-x, -z)).collect::<Vec<_>>()
        );
        for &(x, z) in &coral {
            assert!(x < 0);
            assert!(x.abs() <= HALF_X - CRAFT_RADIUS && z.abs() <= HALF_Z - CRAFT_RADIUS);
            assert!(OBSTACLES.iter().all(|o| !o.touches(x, z, CRAFT_RADIUS)));
        }
    }

    #[test]
    fn cover_blocks_sight() {
        // The crystal stands between the two ends of the arena's long axis.
        assert!(!line_of_sight((-1000, 0), (1000, 0)));
        assert!(line_of_sight((-1000, 1300), (1000, 1300)));
        assert!(line_of_sight((1500, 1300), (1500, 1300)));
    }
}
