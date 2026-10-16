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
    let mut all = [Obstacle::Round {
        x: 0,
        z: 0,
        radius: 90,
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
    use super::{HALF_X, HALF_Z, OBSTACLES, Obstacle, spawn};
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
}
